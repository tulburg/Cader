// Local suggestion models (S-4, D-4, D-6). One API for every editing task:
//   correct(text)                       grammarly/coedit-large, int8 ONNX via ort
//   rephrase / substitute / alternatives  Qwen2.5-14B-Instruct Q4_K_M via llama.cpp (Metal)
// Both load lazily on first use. A request carries a key (the span it is for); a newer request
// with the same key, or cancel(key), stops the older one between tokens.

use crate::fetch::{self, Remote};
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::LlamaModel;
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::token::logit_bias::LlamaLogitBias;
use ort::session::Session;
use ort::value::Tensor;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::num::NonZeroU32;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, State};

pub const FILES: [Remote; 6] = [
    Remote {
        url: "https://huggingface.co/rabden/coedit-large-onnx/resolve/main/onnx/encoder_model_quantized.onnx",
        file: "coedit/encoder.onnx",
        sha256: "60f16512ed9a21c6172966442a711d39107e7c5e205e0dec3535b8d73309f5f0",
        size: 342_068_078,
    },
    Remote {
        url: "https://huggingface.co/rabden/coedit-large-onnx/resolve/main/onnx/decoder_model_merged_quantized.onnx",
        file: "coedit/decoder.onnx",
        sha256: "a852d5e8e7fd29cfd92b03b4f58f0cf036435de43a0e6f8e0b2bb6f84f5b77fd",
        size: 476_342_549,
    },
    Remote {
        url: "https://huggingface.co/rabden/coedit-large-onnx/resolve/main/tokenizer.json",
        file: "coedit/tokenizer.json",
        sha256: TOKENIZER_SHA256,
        size: 2_422_332,
    },
    // Qwen's own GGUF comes in three parts; llama.cpp loads them from the first.
    Remote {
        url: "https://huggingface.co/Qwen/Qwen2.5-14B-Instruct-GGUF/resolve/main/qwen2.5-14b-instruct-q4_k_m-00001-of-00003.gguf",
        file: "qwen2.5-14b/qwen2.5-14b-instruct-q4_k_m-00001-of-00003.gguf",
        sha256: "a09ea5e7b1eafb1b30b241726c3cc3c905c96f14ad41e246ffa5f44e53904f68",
        size: 3_991_999_872,
    },
    Remote {
        url: "https://huggingface.co/Qwen/Qwen2.5-14B-Instruct-GGUF/resolve/main/qwen2.5-14b-instruct-q4_k_m-00002-of-00003.gguf",
        file: "qwen2.5-14b/qwen2.5-14b-instruct-q4_k_m-00002-of-00003.gguf",
        sha256: "21b9457d079680d284e90ef69607c4b2d8ef64a09d4729cb7b5e1357bdba41ae",
        size: 3_989_373_504,
    },
    Remote {
        url: "https://huggingface.co/Qwen/Qwen2.5-14B-Instruct-GGUF/resolve/main/qwen2.5-14b-instruct-q4_k_m-00003-of-00003.gguf",
        file: "qwen2.5-14b/qwen2.5-14b-instruct-q4_k_m-00003-of-00003.gguf",
        sha256: "c8d37006760a387a35216e070e6664d7da927f10be8eb870fef2e3d4833d9976",
        size: 1_006_737_120,
    },
];
const QWEN: &str = "qwen2.5-14b/qwen2.5-14b-instruct-q4_k_m-00001-of-00003.gguf";
const TOKENIZER_SHA256: &str = "8c3804f01b141a4f28649b2ff899f7eb3bedad28fd898f8c38b7dbc70db700bf";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Opt {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase", tag = "state")]
enum Event {
    Downloading { progress: f32 },
    Ready,
    Error { message: String },
}

#[derive(Default)]
pub struct Models {
    coedit: Mutex<Option<Arc<Coedit>>>,
    qwen: Mutex<Option<Arc<Qwen>>>,
    downloading: AtomicBool,
    tickets: Mutex<HashMap<String, u64>>,
    next: AtomicU64,
}

const CANCELLED: &str = "cancelled";

impl Models {
    // Frees the models before the process exits; a llama model still alive at exit trips a
    // Metal assert in ggml's teardown.
    pub fn unload(&self) {
        self.qwen.lock().unwrap().take();
        self.coedit.lock().unwrap().take();
    }

    // A new request for `key` supersedes any older one still running.
    fn ticket(&self, key: &str) -> Ticket<'_> {
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        self.tickets.lock().unwrap().insert(key.to_string(), id);
        Ticket { models: self, key: key.to_string(), id }
    }
}

struct Ticket<'a> {
    models: &'a Models,
    key: String,
    id: u64,
}

impl Ticket<'_> {
    fn live(&self) -> bool {
        self.models.tickets.lock().unwrap().get(&self.key) == Some(&self.id)
    }
}

// A finished request drops its entry, unless a newer request for the key has replaced it.
impl Drop for Ticket<'_> {
    fn drop(&mut self) {
        let mut tickets = self.models.tickets.lock().unwrap();
        if tickets.get(&self.key) == Some(&self.id) {
            tickets.remove(&self.key);
        }
    }
}

// ---- Commands ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    ready: bool,
    downloading: bool,
}

#[tauri::command]
pub fn models_status(app: AppHandle, state: State<Models>) -> Result<Status, String> {
    Ok(Status { ready: fetch::present(&fetch::models_dir(&app)?, &FILES), downloading: state.downloading.load(Ordering::SeqCst) })
}

#[tauri::command]
pub fn models_download(app: AppHandle, state: State<Models>) -> Result<(), String> {
    if state.downloading.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    std::thread::spawn(move || {
        let emit = |e: Event| {
            let _ = app.emit("models", e);
        };
        emit(Event::Downloading { progress: 0.0 });
        let result = fetch::models_dir(&app).and_then(|dir| fetch::download_all(&dir, &FILES, |p| emit(Event::Downloading { progress: p })));
        use tauri::Manager;
        app.state::<Models>().downloading.store(false, Ordering::SeqCst);
        match result {
            Ok(()) => emit(Event::Ready),
            Err(e) => emit(Event::Error { message: format!("Model download failed: {e}") }),
        }
    });
    Ok(())
}

#[tauri::command]
pub fn cancel(state: State<Models>, key: String) {
    state.tickets.lock().unwrap().remove(&key);
}

#[tauri::command]
pub async fn correct(app: AppHandle, text: String, key: String) -> Result<String, String> {
    run(app, move |m, dir| {
        let t = m.ticket(&key);
        coedit(m, dir)?.edit("Fix grammar in this sentence", &text, &t)
    })
    .await
}

#[tauri::command]
pub async fn rephrase(app: AppHandle, span: String, context: String, n: usize, exclude: Vec<String>, key: String) -> Result<Vec<Opt>, String> {
    let app2 = app.clone();
    run(app, move |m, dir| {
        let t = m.ticket(&key);
        qwen(m, dir)?.rephrase(&span, &context, n, &exclude, &mut streamer(&app2, &key), &|| t.live())
    })
    .await
}

#[tauri::command]
pub async fn substitute(app: AppHandle, span: String, context: String, n: usize, exclude: Vec<String>, key: String) -> Result<Vec<Opt>, String> {
    let app2 = app.clone();
    run(app, move |m, dir| {
        let t = m.ticket(&key);
        qwen(m, dir)?.substitute(&span, &context, n, &exclude, &mut streamer(&app2, &key), &|| t.live())
    })
    .await
}

#[tauri::command]
pub async fn alternatives(app: AppHandle, sentence: String, n: usize, exclude: Vec<String>, key: String) -> Result<Vec<Opt>, String> {
    let app2 = app.clone();
    run(app, move |m, dir| {
        let t = m.ticket(&key);
        qwen(m, dir)?.alternatives(&sentence, n, &exclude, &mut streamer(&app2, &key), &|| t.live())
    })
    .await
}

// Each option is sent to the UI as soon as the model finishes writing it (event "option"), so
// the first one shows long before the batch is done. The command still returns the whole batch.
#[derive(Serialize, Clone)]
struct OptionEvent<'a> {
    key: &'a str,
    option: &'a Opt,
}

fn streamer<'a>(app: &'a AppHandle, key: &'a str) -> impl FnMut(&Opt) + 'a {
    move |o: &Opt| {
        let _ = app.emit("option", OptionEvent { key, option: o });
    }
}

async fn run<T: Send + 'static>(app: AppHandle, f: impl FnOnce(&Models, &Path) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let dir = fetch::models_dir(&app)?;
    if !fetch::present(&dir, &FILES) {
        return Err("models-missing".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<Models>();
        f(&state, &dir)
    })
    .await
    .map_err(|e| e.to_string())?
}

// A rewrite of a span sometimes runs on into the words around it ("kept our promise to every
// child..."). Cut what repeats the text just before or after the span.
pub fn fit_span(option: &str, span: &str, context: &str) -> String {
    let Some(i) = context.find(span) else { return option.to_string() };
    let norm = |w: &str| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
    let before: Vec<String> = context[..i].split_whitespace().map(norm).collect();
    let after: Vec<String> = context[i + span.len()..].split_whitespace().map(norm).filter(|w| !w.is_empty()).collect();
    let mut words: Vec<&str> = option.split_whitespace().collect();
    // Trailing words that restate the start of what follows: cut at a two-word anchor.
    let anchor = after.len().min(2);
    if anchor > 0 {
        if let Some(j) = (1..words.len()).find(|&j| j + anchor <= words.len() && (0..anchor).all(|k| norm(words[j + k]) == after[k])) {
            words.truncate(j);
        }
    }
    // Leading words that restate the end of what comes before.
    let lead = (1..=before.len().min(words.len().saturating_sub(1))).rev().find(|&k| (0..k).all(|x| norm(words[x]) == before[before.len() - k + x]));
    if let Some(k) = lead {
        words.drain(..k);
    }
    words.join(" ").trim_end_matches(|c| c == ',' || c == ';').to_string()
}

// The span is marked in place with [brackets] so the model knows exactly what to replace.
fn bracket(span: &str, context: &str) -> String {
    match context.find(span) {
        Some(i) => format!("{}[{span}]{}", &context[..i], &context[i + span.len()..]),
        None => format!("{context} [{span}]"),
    }
}

pub fn rephrase_prompt(span: &str, context: &str, n: usize, exclude: &[String]) -> String {
    format!(
        "Sentence: \"{}\"\nRewrite the words in [brackets] in {n} different ways. Each rewrite must say everything the bracketed words say, in new wording, and read naturally in place of the brackets.{}\nExample for \"We [worked really hard on it] all year.\": [{{\"text\": \"poured ourselves into it\"}}, {{\"text\": \"put in long, hard hours on it\"}}, {{\"text\": \"gave it everything we had\"}}]\nAnswer with only the JSON array.",
        bracket(span, context),
        avoid(exclude)
    )
}

pub fn substitute_prompt(span: &str, context: &str, n: usize, exclude: &[String]) -> String {
    format!(
        "Give {n} words or short phrases that mean \"{span}\", stronger or more precise than it. Each will replace \"{span}\" in this sentence, so it must fit there: \"{context}\"{}\nExample for \"very cold\" in \"It was very cold outside.\": [{{\"text\": \"freezing\", \"note\": \"extreme cold\"}}, {{\"text\": \"bitter\", \"note\": \"harsh, biting cold\"}}]\nAnswer with only the JSON array.",
        avoid(exclude)
    )
}

pub fn alternatives_prompt(sentence: &str, n: usize, exclude: &[String]) -> String {
    format!(
        "Sentence: \"{sentence}\"\nWrite {n} other ways to say exactly this sentence. Keep every fact and the same meaning, and do not add, drop or reverse anything; change the structure, order or emphasis, not only single words.{}\nExample for \"We could not have done it without you.\": [{{\"text\": \"Without you, we could never have done it.\"}}, {{\"text\": \"You are the reason we were able to do it.\"}}]\nAnswer with only the JSON array.",
        avoid(exclude)
    )
}

// The small model often repeats earlier options even when told not to, so a "More" batch asks
// for a few extra and the repeats are filtered out.
fn ask_count(n: usize, exclude: &[String]) -> usize {
    if exclude.is_empty() { n } else { n + 3 }
}

fn avoid(exclude: &[String]) -> String {
    if exclude.is_empty() {
        String::new()
    } else {
        format!(" Do not repeat any of these: {}.", exclude.iter().map(|e| format!("\"{e}\"")).collect::<Vec<_>>().join(", "))
    }
}

// Compared without punctuation or case, so "sweat, and tears" repeats "sweat and tears".
fn norm(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric() || c.is_whitespace()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

// Pull the JSON array out of the reply, drop repeats, echoes of the original and anything
// already shown, and keep at most n.
pub fn options(reply: String, original: &str, exclude: &[String], n: usize) -> Result<Vec<Opt>, String> {
    // Each {...} is read on its own, so one malformed object does not lose the batch.
    let mut parsed: Vec<Opt> = Vec::new();
    let mut rest = reply.as_str();
    while let Some(a) = rest.find('{') {
        let Some(len) = rest[a..].find('}') else { break };
        if let Ok(o) = serde_json::from_str::<Opt>(&rest[a..=a + len]) {
            parsed.push(o);
        }
        rest = &rest[a + len + 1..];
    }
    // Small models sometimes answer with a plain list instead: [a, b, c] or one item per line.
    if parsed.is_empty() {
        let body = match (reply.find('['), reply.rfind(']')) {
            (Some(a), Some(b)) if a < b => reply[a + 1..b].to_string(),
            _ => reply.replace('\n', ","),
        };
        parsed = body
            .split(',')
            .map(|t| t.trim().trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == '-' || c == '*' || c == ')').trim().trim_matches(|c| c == '"' || c == '\''))
            .filter(|t| !t.is_empty() && t.len() <= 200 && !t.starts_with("```"))
            .map(|t| Opt { text: t.to_string(), note: None })
            .collect();
    }
    if parsed.is_empty() {
        return Err(format!("The model did not return options: {reply}"));
    }
    let mut seen: Vec<String> = exclude.iter().map(|s| norm(s)).collect();
    let orig = norm(original);
    seen.push(orig.clone());
    let mut out = Vec::new();
    for mut o in parsed {
        o.text = o.text.trim().to_string();
        let k = norm(&o.text);
        // An option that still contains the original words is not a new way of saying them.
        if k.is_empty() || seen.contains(&k) || (orig.contains(' ') && k.contains(&orig)) {
            continue;
        }
        seen.push(k);
        out.push(o);
        if out.len() == n {
            break;
        }
    }
    Ok(out)
}

fn coedit(m: &Models, dir: &Path) -> Result<Arc<Coedit>, String> {
    let mut slot = m.coedit.lock().unwrap();
    if slot.is_none() {
        *slot = Some(Arc::new(Coedit::load(&dir.join("coedit"))?));
    }
    Ok(slot.as_ref().unwrap().clone())
}

fn qwen(m: &Models, dir: &Path) -> Result<Arc<Qwen>, String> {
    let mut slot = m.qwen.lock().unwrap();
    if slot.is_none() {
        *slot = Some(Arc::new(Qwen::load(&dir.join(QWEN))?));
    }
    Ok(slot.as_ref().unwrap().clone())
}

// ---- CoEdIT: T5 encoder + merged decoder with KV cache, greedy decoding ----

const LAYERS: usize = 24;
const HEADS: i64 = 16;
const D_KV: i64 = 64;
const EOS: i64 = 1;
const START: i64 = 0;

pub struct Coedit {
    tok: tokenizers::Tokenizer,
    encoder: Mutex<Session>,
    decoder: Mutex<Session>,
}

type Kv = (Vec<i64>, Vec<f32>);

impl Coedit {
    pub fn load(dir: &Path) -> Result<Self, String> {
        let tok = tokenizers::Tokenizer::from_file(dir.join("tokenizer.json")).map_err(|e| e.to_string())?;
        let open = |f: &str| -> Result<Session, String> {
            Session::builder().and_then(|b| b.with_intra_threads(4)).and_then(|b| b.commit_from_file(dir.join(f))).map_err(|e| format!("{f}: {e}"))
        };
        Ok(Coedit { tok, encoder: Mutex::new(open("encoder.onnx")?), decoder: Mutex::new(open("decoder.onnx")?) })
    }

    fn edit(&self, instruction: &str, text: &str, ticket: &Ticket) -> Result<String, String> {
        let out = self.generate(&format!("{instruction}: {text}"), 192, &|| ticket.live())?;
        Ok(same_sentence_count(text, &out))
    }

    pub fn generate(&self, prompt: &str, max: usize, live: &dyn Fn() -> bool) -> Result<String, String> {
        let enc = self.tok.encode(prompt, true).map_err(|e| e.to_string())?;
        let ids: Vec<i64> = enc.get_ids().iter().map(|&i| i as i64).collect();
        let n = ids.len() as i64;
        let mask = vec![1i64; ids.len()];
        let err = |e: ort::Error| e.to_string();

        let hidden: Kv = {
            let mut s = self.encoder.lock().unwrap();
            let out = s
                .run(ort::inputs![
                    "input_ids" => Tensor::from_array((vec![1, n], ids.clone())).map_err(err)?,
                    "attention_mask" => Tensor::from_array((vec![1, n], mask.clone())).map_err(err)?,
                ])
                .map_err(err)?;
            let (shape, data) = out["last_hidden_state"].try_extract_tensor::<f32>().map_err(err)?;
            (shape.to_vec(), data.to_vec())
        };

        let mut past: Vec<[Kv; 2]> = vec![[(vec![1, HEADS, 0, D_KV], vec![]), (vec![1, HEADS, 0, D_KV], vec![])]; LAYERS];
        let mut out_ids: Vec<u32> = Vec::new();
        let mut last = START;
        let mut decoder = self.decoder.lock().unwrap();
        for _ in 0..max {
            if !live() {
                return Err(CANCELLED.into());
            }
            let mut inputs: Vec<(std::borrow::Cow<str>, ort::session::SessionInputValue)> = vec![
                ("input_ids".into(), Tensor::from_array((vec![1i64, 1], vec![last])).map_err(err)?.into()),
                ("encoder_attention_mask".into(), Tensor::from_array((vec![1, n], mask.clone())).map_err(err)?.into()),
                ("encoder_hidden_states".into(), Tensor::from_array(hidden.clone()).map_err(err)?.into()),
            ];
            for (l, kv) in past.iter().enumerate() {
                for (k, which) in ["key", "value"].iter().enumerate() {
                    inputs.push((format!("past_key_values.{l}.decoder.{which}").into(), kv_tensor(&kv[k]).map_err(err)?.into()));
                }
            }
            let out = decoder.run(inputs).map_err(err)?;
            let (shape, logits) = out["logits"].try_extract_tensor::<f32>().map_err(err)?;
            let vocab = *shape.last().unwrap() as usize;
            let row = &logits[logits.len() - vocab..];
            // Greedy T5 tends to loop on the tail of a sentence; never repeat a 3-gram.
            let banned = repeat_bans(&out_ids, 3);
            let next = row.iter().enumerate().filter(|(i, _)| !banned.contains(&(*i as u32))).fold((0usize, f32::MIN), |b, (i, &v)| if v > b.1 { (i, v) } else { b }).0 as i64;
            for (l, kv) in past.iter_mut().enumerate() {
                for (k, which) in ["key", "value"].iter().enumerate() {
                    let (s, d) = out[format!("present.{l}.decoder.{which}").as_str()].try_extract_tensor::<f32>().map_err(err)?;
                    kv[k] = (s.to_vec(), d.to_vec());
                }
            }
            if next == EOS {
                break;
            }
            out_ids.push(next as u32);
            last = next;
        }
        let text = self.tok.decode(&out_ids, true).map_err(|e| e.to_string())?;
        Ok(text.trim().to_string())
    }
}

// The int8 decoder sometimes runs on past the end and repeats the sentence's tail. A correction
// has as many sentences as its input, so anything after that is dropped.
pub fn same_sentence_count(input: &str, out: &str) -> String {
    let ends = |s: &str| s.match_indices(|c| c == '.' || c == '!' || c == '?').filter(|(i, _)| s[i + 1..].chars().next().map_or(true, char::is_whitespace)).map(|(i, _)| i).collect::<Vec<_>>();
    let want = ends(input.trim()).len().max(1);
    match ends(out).get(want - 1) {
        Some(&i) => out[..=i].trim().to_string(),
        None => out.trim().to_string(),
    }
}

// Tokens that would complete an n-gram already present in `ids` (no_repeat_ngram_size).
fn repeat_bans(ids: &[u32], n: usize) -> Vec<u32> {
    if ids.len() < n - 1 {
        return vec![];
    }
    let tail = &ids[ids.len() - (n - 1)..];
    ids.windows(n).filter(|w| &w[..n - 1] == tail).map(|w| w[n - 1]).collect()
}

// The first step has no past; ort only builds a zero-length tensor through its allocator.
fn kv_tensor(kv: &Kv) -> ort::Result<Tensor<f32>> {
    if kv.1.is_empty() {
        Tensor::<f32>::new(&ort::memory::Allocator::default(), kv.0.clone())
    } else {
        Tensor::from_array(kv.clone())
    }
}

// ---- Qwen: chat prompt in, text out ----

pub struct Qwen {
    model: LlamaModel,
}

fn backend() -> Result<&'static LlamaBackend, String> {
    static BACKEND: OnceLock<LlamaBackend> = OnceLock::new();
    if let Some(b) = BACKEND.get() {
        return Ok(b);
    }
    let mut b = LlamaBackend::init().map_err(|e| e.to_string())?;
    if std::env::var_os("CADER_LLAMA_LOGS").is_none() {
        b.void_logs();
    }
    Ok(BACKEND.get_or_init(|| b))
}

// Constrains the reply to a JSON array of exactly n options, so a small model cannot wander
// out of the format (S-4 Req 6).
fn options_grammar(n: usize, note: bool) -> String {
    let note = if note { r#" "," ws "\"note\"" ws ":" ws str"# } else { "" };
    format!(
        r#"root ::= "[" ws item ("," ws item){{{}}} ws "]"
item ::= "{{" ws "\"text\"" ws ":" ws str{note} ws "}}"
str ::= "\"" [^"\\\n]+ "\""
ws ::= [ \n]?"#,
        n.saturating_sub(1)
    )
}

const SYSTEM: &str = "You are an English writing assistant inside an editor for speeches and blog posts. You only suggest wording. You always answer with valid JSON and nothing else.";

impl Qwen {
    pub fn load(path: &Path) -> Result<Self, String> {
        let params = LlamaModelParams::default().with_n_gpu_layers(1000);
        let model = LlamaModel::load_from_file(backend()?, path, &params).map_err(|e| format!("Could not load the suggestion model: {e}"))?;
        Ok(Qwen { model })
    }

    // A JSON array of n options; earlier options are steered away from while sampling.
    #[cfg(test)]
    pub fn ask(&self, user: &str, n: usize, note: bool, exclude: &[String], live: &dyn Fn() -> bool) -> Result<String, String> {
        self.ask_at(user, n, note, exclude, 0.4, live, &mut |_| {})
    }

    #[allow(clippy::too_many_arguments)]
    fn ask_at(&self, user: &str, n: usize, note: bool, exclude: &[String], temp: f32, live: &dyn Fn() -> bool, on_text: &mut dyn FnMut(&str)) -> Result<String, String> {
        let vocab = self.model.vocab();
        let mut bias = Vec::new();
        for e in exclude {
            for form in [e.clone(), format!(" {e}")] {
                let toks = vocab.tokenize(form.as_bytes(), false, false);
                // A one-token word is banned outright; a word split in two or three is discouraged.
                match toks.len() {
                    1 => bias.push(LlamaLogitBias::new(toks[0], f32::NEG_INFINITY)),
                    2 | 3 => bias.push(LlamaLogitBias::new(toks[0], -3.0)),
                    _ => {}
                }
            }
        }
        self.generate(user, 120 * n.max(1), Some(&options_grammar(n, note)), &bias, temp, live, on_text)
    }

    // Asks for k options and hands each new one to `emit` as soon as its JSON object is complete,
    // after `fit` and de-duplication against `seen`, the original and what was already sent.
    #[allow(clippy::too_many_arguments)]
    fn stream(&self, prompt: &str, k: usize, note: bool, seen: &[String], temp: f32, original: &str, fit: &dyn Fn(String) -> String, want: usize, emit: &mut dyn FnMut(&Opt), live: &dyn Fn() -> bool) -> Result<Vec<Opt>, String> {
        let orig = norm(original);
        let seen_n: Vec<String> = seen.iter().map(|x| norm(x)).collect();
        let mut out: Vec<Opt> = Vec::new();
        let mut closes = 0;
        // Generation stops as soon as enough distinct options are in.
        let enough = std::cell::Cell::new(false);
        let go = || live() && !enough.get();
        {
            let mut on_text = |text: &str| {
                let c = text.matches('}').count();
                if c == closes {
                    return;
                }
                closes = c;
                let Ok(list) = options(text.to_string(), original, seen, k) else { return };
                for mut o in list {
                    o.text = fit(o.text);
                    let key = norm(&o.text);
                    let echo = key.is_empty() || key == orig || (orig.contains(' ') && key.contains(&orig)) || seen_n.contains(&key);
                    if out.len() >= want || echo || out.iter().any(|x| norm(&x.text) == key) {
                        continue;
                    }
                    emit(&o);
                    out.push(o);
                }
                enough.set(out.len() >= want);
            };
            match self.ask_at(prompt, k, note, seen, temp, &go, &mut on_text) {
                Err(e) if e == CANCELLED && enough.get() => {}
                r => {
                    r?;
                }
            }
        }
        Ok(out)
    }

    pub fn substitute(&self, span: &str, context: &str, n: usize, exclude: &[String], emit: &mut dyn FnMut(&Opt), live: &dyn Fn() -> bool) -> Result<Vec<Opt>, String> {
        let k = ask_count(n, exclude);
        self.stream(&substitute_prompt(span, context, k, exclude), k, true, exclude, 0.4, span, &|t| t, n, emit, live)
    }

    // Rewrites of a span, trimmed so each one fits back in place.
    pub fn rephrase(&self, span: &str, context: &str, n: usize, exclude: &[String], emit: &mut dyn FnMut(&Opt), live: &dyn Fn() -> bool) -> Result<Vec<Opt>, String> {
        let k = ask_count(n, exclude);
        let fit = |t: String| fit_span(&t.replace(['[', ']'], ""), span, context);
        self.stream(&rephrase_prompt(span, context, k, exclude), k, false, exclude, 0.4, span, &fit, n, emit, live)
    }

    // A batch that comes back short after repeats are removed is topped up (twice at most).
    pub fn alternatives(&self, sentence: &str, n: usize, exclude: &[String], emit: &mut dyn FnMut(&Opt), live: &dyn Fn() -> bool) -> Result<Vec<Opt>, String> {
        let mut seen = exclude.to_vec();
        let mut out = Vec::new();
        for attempt in 0..3 {
            let want = n - out.len();
            let k = ask_count(want, &seen);
            // Each top-up samples hotter, so it does not land on the same repeats again.
            let temp = 0.4 + 0.3 * attempt as f32;
            let got = self.stream(&alternatives_prompt(sentence, k, &seen), k, false, &seen, temp, sentence, &|t| t, want, emit, live)?;
            seen.extend(got.iter().map(|o| o.text.clone()));
            out.extend(got);
            if out.len() >= n {
                break;
            }
        }
        Ok(out)
    }

    #[cfg(test)]
    pub fn chat(&self, user: &str, max: usize, live: &dyn Fn() -> bool) -> Result<String, String> {
        self.generate(user, max, None, &[], 0.4, live, &mut |_| {})
    }

    #[allow(clippy::too_many_arguments)]
    fn generate(&self, user: &str, max: usize, grammar: Option<&str>, bias: &[LlamaLogitBias], temp: f32, live: &dyn Fn() -> bool, on_text: &mut dyn FnMut(&str)) -> Result<String, String> {
        let prompt = format!("<|im_start|>system\n{SYSTEM}<|im_end|>\n<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n");
        let vocab = self.model.vocab();
        let tokens = vocab.tokenize(prompt.as_bytes(), false, true);
        let ctx_params = LlamaContextParams::default().with_n_ctx(NonZeroU32::new(2048)).with_n_batch(1024);
        let mut ctx = self.model.new_context(backend()?, ctx_params).map_err(|e| e.to_string())?;
        let mut batch = LlamaBatch::new(1024, 1);
        let lastp = tokens.len() as i32 - 1;
        for (i, t) in tokens.iter().enumerate() {
            batch.add(*t, i as i32, &[0], i as i32 == lastp).map_err(|e| e.to_string())?;
        }
        ctx.decode(&mut batch).map_err(|e| e.to_string())?;
        let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(7);
        let mut chain = Vec::new();
        if let Some(g) = grammar {
            chain.push(LlamaSampler::grammar(&self.model, g, "root").map_err(|e| format!("grammar: {e}"))?);
        }
        if !bias.is_empty() {
            chain.push(LlamaSampler::logit_bias(self.model.n_vocab(), bias));
        }
        chain.extend([LlamaSampler::top_k(40), LlamaSampler::top_p(0.9, 1), LlamaSampler::temp(temp), LlamaSampler::dist(seed)]);
        let mut sampler = LlamaSampler::chain_simple(chain);
        let mut pos = tokens.len() as i32;
        let mut bytes = Vec::new();
        for _ in 0..max {
            if !live() {
                return Err(CANCELLED.into());
            }
            let tok = sampler.sample(&ctx, batch.n_tokens() - 1); // also accepts the token
            if vocab.is_eog(tok) {
                break;
            }
            bytes.extend(vocab.token_to_piece(tok, false, None));
            on_text(&String::from_utf8_lossy(&bytes));
            batch.clear();
            batch.add(tok, pos, &[0], true).map_err(|e| e.to_string())?;
            pos += 1;
            ctx.decode(&mut batch).map_err(|e| e.to_string())?;
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn options_parse_and_dedupe() {
        let reply = "Sure:\n[{\"text\":\"vital\",\"note\":\"needed\"},{\"text\":\"Vital.\"},{\"text\":\"very important\"},{\"text\":\"crucial\"},{\"text\":\"key\"}]".to_string();
        let got = options(reply, "very important", &["key".into()], 5).unwrap();
        assert_eq!(got.iter().map(|o| o.text.as_str()).collect::<Vec<_>>(), ["vital", "crucial"]);
        assert!(options("".into(), "x", &[], 3).is_err());
        let plain = options("[extremely large, colossal, \"immense\"]".into(), "big", &[], 5).unwrap();
        assert_eq!(plain.iter().map(|o| o.text.as_str()).collect::<Vec<_>>(), ["extremely large", "colossal", "immense"]);
        let broken = "```json\n[{\"text\": \"vast\"}, {\"text\": \"huge\"}}\n```".to_string();
        assert_eq!(options(broken, "big", &[], 5).unwrap().len(), 2);
    }

    fn dir() -> std::path::PathBuf {
        std::path::PathBuf::from(std::env::var("CADER_MODELS").expect("CADER_MODELS"))
    }

    // CADER_MODELS=<models folder> cargo test --release -- --ignored --nocapture
    #[test]
    #[ignore]
    fn coedit_fixes_grammar() {
        let c = Coedit::load(&dir().join("coedit")).unwrap();
        let _ = c.generate("Fix grammatical errors in this sentence: warm up", 8, &|| true);
        // Acceptance: a ~20 word sentence with three errors comes back fixed in under 1.5 s.
        for (wrong, right) in [
            ("The people who has worked on this renovation gave more then there time.", "The people who have worked on this renovation gave more than their time."),
            ("Me and my sister goes to the library every weeks to borrow book for our school projects.", ""),
        ] {
            let t = Instant::now();
            let out = c.generate(&format!("Fix grammar in this sentence: {wrong}"), 192, &|| true).unwrap();
            let secs = t.elapsed().as_secs_f32();
            println!("coedit {secs:.2}s: {out}");
            assert!(secs < 1.5);
            if !right.is_empty() {
                assert_eq!(out, right);
            }
        }
    }

    #[test]
    #[ignore]
    fn qwen_gives_distinct_substitutes() {
        let q = Qwen::load(&dir().join(QWEN)).unwrap();
        let t = Instant::now();
        let reply = q.ask(&substitute_prompt("very important", "The idea of a public library was very important to the families who lived here.", 5, &[]), 5, true, &[], &|| true).unwrap();
        let got = options(reply.clone(), "very important", &[], 5).unwrap();
        println!("qwen {:.2}s: {got:?}", t.elapsed().as_secs_f32());
        assert!(got.len() >= 3, "{reply}");
    }

    // Prints CoEdIT's correction of each line of CADER_SENTENCES as JSON, for checking the UI diff.
    #[test]
    #[ignore]
    fn coedit_corrects_lines() {
        let Ok(lines) = std::env::var("CADER_SENTENCES") else { return };
        let c = Coedit::load(&dir().join("coedit")).unwrap();
        for line in lines.lines() {
            let out = same_sentence_count(line, &c.generate(&format!("Fix grammar in this sentence: {line}"), 192, &|| true).unwrap());
            println!("CORR {}", serde_json::json!([line, out]));
        }
    }

    #[test]
    #[ignore]
    fn qwen_speed() {
        let q = Qwen::load(&dir().join(QWEN)).unwrap();
        let _ = q.chat("Say hi.", 4, &|| true);
        let t = Instant::now();
        let out = q.chat("Write a long paragraph about libraries.", 200, &|| true).unwrap();
        let plain = t.elapsed().as_secs_f32();
        let t = Instant::now();
        let json = q.ask(&substitute_prompt("very big", "The hall was very big and full of light.", 5, &[]), 5, true, &[], &|| true).unwrap();
        let constrained = t.elapsed().as_secs_f32();
        println!("SPEED plain 200 tokens: {plain:.2}s ({:.1} tok/s, {} chars); grammar batch: {constrained:.2}s ({} chars)", 200.0 / plain, out.len(), json.len());
    }

    // Req: a cancelled request stops within 200 ms.
    #[test]
    #[ignore]
    fn qwen_cancel_is_fast() {
        let q = Qwen::load(&dir().join(QWEN)).unwrap();
        let stop = std::sync::atomic::AtomicBool::new(false);
        let mut cancelled_at = None;
        std::thread::scope(|sc| {
            let h = sc.spawn(|| q.chat("Write a long essay about libraries.", 2000, &|| !stop.load(Ordering::SeqCst)));
            std::thread::sleep(std::time::Duration::from_millis(500));
            stop.store(true, Ordering::SeqCst);
            cancelled_at = Some(Instant::now());
            assert_eq!(h.join().unwrap(), Err(CANCELLED.to_string()));
        });
        let ms = cancelled_at.unwrap().elapsed().as_millis();
        println!("cancel took {ms} ms");
        assert!(ms < 200);
    }

    #[test]
    fn corrections_keep_the_input_sentence_count() {
        assert_eq!(same_sentence_count("It ends here", "It ends here. ends here."), "It ends here.");
        assert_eq!(same_sentence_count("One. Two.", "One. Two. Two."), "One. Two.");
        assert_eq!(same_sentence_count("Mr. Smith ate.", "Mr. Smith ate."), "Mr. Smith ate.");
        assert_eq!(same_sentence_count("No end", "No end"), "No end");
    }

    #[test]
    fn rewrites_fit_the_span() {
        let ctx = "We are keeping a promise that was made to every child who ever sat on that carpet.";
        let span = "keeping a promise that was made";
        assert_eq!(fit_span("kept our promise to every child who ever sat on that carpet", span, ctx), "kept our promise");
        assert_eq!(fit_span("honoring a pledge", span, ctx), "honoring a pledge");
        let ctx = "The idea of a public library was very important to the families who lived here.";
        assert_eq!(fit_span("was of great significance to the families here", "very important", ctx), "of great significance");
        let ctx = "They gave their weekends, their patience, and in a few cases, their actual blood, sweat and tears.";
        assert_eq!(
            fit_span("They gave their weekends, their patience, and in a few cases, everything they had", "their actual blood, sweat and tears", ctx),
            "everything they had"
        );
    }

    #[test]
    fn bans_repeated_trigrams() {
        assert_eq!(repeat_bans(&[5, 6, 7, 9, 5, 6], 3), vec![7]);
        assert!(repeat_bans(&[5, 6], 3).is_empty());
    }

    // S-6 acceptance: Substitute on "very big", then More three times without repeats; Rephrase fits.
    #[test]
    #[ignore]
    fn qwen_selection_actions() {
        let q = Qwen::load(&dir().join(QWEN)).unwrap();
        let ctx = "The hall was very big and full of light.";
        let mut seen: Vec<String> = vec![];
        for round in 0..4 {
            let t = Instant::now();
            let mut first = None;
            let got = q.substitute("very big", ctx, 5, &seen, &mut |_| { first.get_or_insert(t.elapsed().as_secs_f32()); }, &|| true).unwrap();
            println!("substitute round {round} first {:.2}s, all {:.2}s: {:?}", first.unwrap_or(0.0), t.elapsed().as_secs_f32(), got.iter().map(|o| format!("{} ({})", o.text, o.note.clone().unwrap_or_default())).collect::<Vec<_>>());
            assert!(!got.is_empty());
            seen.extend(got.into_iter().map(|o| o.text));
        }
        let lower: Vec<String> = seen.iter().map(|s| s.to_lowercase()).collect();
        let mut dedup = lower.clone();
        dedup.sort();
        dedup.dedup();
        assert_eq!(dedup.len(), lower.len(), "repeats in {seen:?}");
        assert!(lower.iter().any(|w| ["enormous", "immense", "vast", "huge", "massive", "spacious", "colossal", "cavernous"].contains(&w.as_str())), "{seen:?}");
        let idiom = q.rephrase("their actual blood, sweat and tears", "They gave their weekends, their patience, and in a few cases, their actual blood, sweat and tears.", 3, &[], &mut |_| {}, &|| true).unwrap();
        println!("rephrase idiom: {:?}", idiom.iter().map(|o| &o.text).collect::<Vec<_>>());
        // Idioms are the hardest case; reported, not asserted.
        for (span, ctx2) in [
            ("keeping a promise that was made", "We are keeping a promise that was made to every child who ever sat on that carpet."),
            ("very important", "The idea of a public library was very important to the families who lived here."),
        ] {
            let t = Instant::now();
            let got = q.rephrase(span, ctx2, 3, &[], &mut |_| {}, &|| true).unwrap();
            println!("rephrase {:.2}s: {:?}", t.elapsed().as_secs_f32(), got.iter().map(|o| &o.text).collect::<Vec<_>>());
            assert!(got.len() >= 2);
        }
    }

    // S-7 acceptance: 3 alternatives for each of 10 sentences (meaning checked by reading the
    // output), and More twice gives 9 distinct alternatives.
    #[test]
    #[ignore]
    fn qwen_sentence_alternatives() {
        let q = Qwen::load(&dir().join(QWEN)).unwrap();
        let sentences = [
            "When this building first opened its doors in 1962, the town was much smaller than today.",
            "Tonight we are not just reopening a building, we are keeping a promise to our children.",
            "The people who worked on this renovation gave far more than their time and their skill.",
            "I want to thank every volunteer who spent a weekend sanding shelves and painting the walls.",
            "Our library has always been the one place in town where everyone is welcome, no questions asked.",
            "We raised the money in eighteen months, which is faster than anyone on the council expected.",
            "If you remember coming here as a child, you already know why this place matters so much.",
            "The new reading room faces the river, so the afternoon light falls across every single table.",
            "None of this would have happened without the patience and generosity of the families here.",
            "So let me begin with a simple thank you to the volunteers who made tonight possible.",
        ];
        for s in sentences {
            let t = Instant::now();
            let got = q.alternatives(s, 3, &[], &mut |_| {}, &|| true).unwrap();
            println!("ALT {:.2}s | {s}", t.elapsed().as_secs_f32());
            for o in &got {
                println!("    - {}", o.text);
            }
            assert!(got.len() >= 2, "{got:?}");
        }
        let s = sentences[9];
        let mut seen: Vec<String> = vec![];
        for _ in 0..3 {
            let got = q.alternatives(s, 3, &seen, &mut |_| {}, &|| true).unwrap();
            seen.extend(got.into_iter().map(|o| o.text));
        }
        println!("MORE x2: {} distinct of {}", { let mut d = seen.iter().map(|x| x.to_lowercase()).collect::<Vec<_>>(); d.sort(); d.dedup(); d.len() }, seen.len());
        for x in &seen {
            println!("    * {x}");
        }
        assert_eq!(seen.len(), 9);
    }

    #[test]
    fn cancel_stops_a_running_request() {
        let m = Models::default();
        let first = m.ticket("span-1");
        assert!(first.live());
        let second = m.ticket("span-1");
        assert!(!first.live() && second.live());
        m.tickets.lock().unwrap().remove("span-1");
        assert!(!second.live());

        // Finished requests leave nothing behind; an old one never removes its replacement.
        let old = m.ticket("span-2");
        let new = m.ticket("span-2");
        drop(old);
        assert!(new.live());
        drop(new);
        drop(first);
        drop(second);
        assert!(m.tickets.lock().unwrap().is_empty());
    }
}
