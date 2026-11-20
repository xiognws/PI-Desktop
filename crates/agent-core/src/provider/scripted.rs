//! Deterministic provider for the self-check and integration tests.
//!
//! It replays a fixed list of [`StreamEvent`] sequences, so a turn can be
//! exercised end to end — loop, tool execution, transcript mutation, event
//! order — without a socket, a credential or a paid request. The recorded
//! requests are kept so a test can assert what the loop actually sent.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use super::{BoxFuture, ChatRequest, Provider, ProviderStream, StreamEvent};
use crate::cancel::CancelToken;
use crate::error::{AgentError, ProviderErrorKind, Result};

#[derive(Debug, Default)]
struct Script {
    responses: VecDeque<Vec<StreamEvent>>,
    requests: Vec<ChatRequest>,
}

#[derive(Debug, Default, Clone)]
pub struct ScriptedProvider {
    inner: Arc<Mutex<Script>>,
}

impl ScriptedProvider {
    pub fn new<I>(responses: I) -> Self
    where
        I: IntoIterator<Item = Vec<StreamEvent>>,
    {
        Self {
            inner: Arc::new(Mutex::new(Script {
                responses: responses.into_iter().collect(),
                requests: Vec::new(),
            })),
        }
    }

    /// Requests the loop issued so far, in order.
    pub fn requests(&self) -> Vec<ChatRequest> {
        self.inner.lock().expect("script poisoned").requests.clone()
    }

    pub fn remaining(&self) -> usize {
        self.inner.lock().expect("script poisoned").responses.len()
    }
}

impl Provider for ScriptedProvider {
    fn name(&self) -> &str {
        "scripted"
    }

    fn stream<'a>(
        &'a self,
        request: ChatRequest,
        _cancel: CancelToken,
    ) -> BoxFuture<'a, Result<ProviderStream>> {
        let mut script = self.inner.lock().expect("script poisoned");
        script.requests.push(request);
        match script.responses.pop_front() {
            Some(events) => Box::pin(async move { Ok(ProviderStream::from_events(events)) }),
            None => Box::pin(async move {
                Err(AgentError::provider(
                    ProviderErrorKind::Fatal,
                    "scripted provider ran out of responses",
                ))
            }),
        }
    }
}
