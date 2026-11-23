#!/usr/bin/env python3
"""A Responses-API front end for a real Chat Completions model, for live checks.

Why this exists
---------------
`responses_live.rs` needs an endpoint that speaks the Responses wire *and* returns
streaming text, streamed tool-call arguments and usage. The local gateway
(`127.0.0.1:28787`) answers `POST /v1/responses` with 200 but cannot do any of the
three for streaming requests: its handler reads the upstream stream into a JSON
parse (`server.mjs`, `responses()`), so `content` is always empty, and it maps
neither `tool_calls` nor usage. Pointing the kernel at it therefore proves nothing
about this adapter.

This relay accepts the *Responses* request the kernel builds, validates it
strictly, translates it to `POST /chat/completions` on the real gateway, and
re-emits the gateway's stream as genuine Responses events
(`response.output_text.delta`, `response.output_item.added` for `function_call`,
`response.function_call_arguments.delta`, `response.completed` with usage).
The model, the tool decision, the tool arguments and the token counts are real;
only the Responses framing is produced here.

Strictness is the point: a request shaped like Chat Completions (`messages`,
`tools[].function`, tool results as `role: "tool"` messages) is rejected with 400,
so a passing run proves the adapter's envelope — not just that something answered.

Usage
-----
    python crates/agent-core/tests/support/responses_relay.py --port 28799
    cargo test -p agent-core --test responses_live -- --ignored --nocapture
"""

import argparse
import json
import sys
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM_CHAT = "http://127.0.0.1:28787/v1/chat/completions"


class Rejected(Exception):
    pass


def fail(why):
    raise Rejected(why)


def translate(body):
    """Responses request -> (chat/completions body, notes) with strict checks."""
    if "messages" in body:
        fail("`messages` is the Chat Completions envelope; this endpoint takes `input`")
    for tool in body.get("tools") or []:
        if tool.get("type") != "function":
            fail(f"only function tools are expected here, got {tool.get('type')!r}")
        if "function" in tool:
            fail("tool declarations must be flat (`name`, `parameters`), not `function: {...}`")
        if not tool.get("name") or not isinstance(tool.get("parameters"), dict):
            fail(f"tool {tool.get('name')!r} is missing a name or parameters schema")

    messages = []
    instructions = body.get("instructions")
    if instructions:
        messages.append({"role": "system", "content": str(instructions)})

    items = body.get("input")
    if isinstance(items, str):
        items = [{"role": "user", "content": items}]
    if not isinstance(items, list) or not items:
        fail("`input` must be a non-empty array of items or a string")

    pending_calls = {}
    for item in items:
        if not isinstance(item, dict):
            fail("input items must be objects")
        kind = item.get("type")
        role = item.get("role")
        if kind == "function_call":
            call_id = item.get("call_id")
            if not call_id or not item.get("name"):
                fail("a function_call item needs `call_id` and `name`")
            arguments = item.get("arguments")
            if not isinstance(arguments, str):
                fail("`function_call.arguments` must be a JSON string")
            try:
                json.loads(arguments or "{}")
            except ValueError:
                fail(f"arguments for {item['name']} are not JSON: {arguments!r}")
            pending_calls[call_id] = True
            messages.append({
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": call_id,
                    "type": "function",
                    "function": {"name": item["name"], "arguments": arguments},
                }],
            })
        elif kind == "function_call_output":
            call_id = item.get("call_id")
            if not call_id:
                fail("a function_call_output item needs `call_id`")
            if call_id not in pending_calls:
                fail(f"function_call_output {call_id!r} has no matching function_call item")
            messages.append({
                "role": "tool",
                "tool_call_id": call_id,
                "content": str(item.get("output", "")),
            })
        elif role in ("user", "assistant", "system"):
            if role == "system":
                fail("system text belongs in `instructions`, not in an input item")
            content = item.get("content")
            text_parts = []
            for part in content if isinstance(content, list) else [{"type": "input_text", "text": content}]:
                if not isinstance(part, dict):
                    fail("content parts must be objects")
                ptype = part.get("type")
                if ptype in ("input_text", "output_text", "text"):
                    text_parts.append(part.get("text") or "")
                elif ptype == "input_image":
                    fail("this relay does not transcode images; the live check is text-only")
                else:
                    fail(f"unexpected content part type {ptype!r}")
            messages.append({"role": role, "content": "\n".join(text_parts)})
        else:
            fail(f"unexpected input item {kind or role!r}")

    if not messages:
        fail("the request carried nothing the model could read")

    chat = {
        "model": body.get("model"),
        "messages": messages,
        "stream": True,
    }
    if body.get("max_output_tokens"):
        chat["max_tokens"] = body["max_output_tokens"]
    if body.get("temperature") is not None:
        chat["temperature"] = body["temperature"]
    if body.get("tools"):
        chat["tools"] = [
            {"type": "function", "function": {
                "name": tool["name"],
                "description": tool.get("description", ""),
                "parameters": tool["parameters"],
            }}
            for tool in body["tools"]
        ]
    return chat


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, fmt, *args):  # keep the transcript readable
        sys.stderr.write("relay: " + fmt % args + "\n")

    def _send_error_json(self, status, message):
        payload = json.dumps({"error": {"message": message, "type": "relay_rejected"}}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", "/v1/health"):
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
            return
        self._send_error_json(404, "not found")

    def do_POST(self):
        if self.path.rstrip("/") != "/v1/responses":
            self._send_error_json(404, f"no route for {self.path}")
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw)
        except ValueError as error:
            self._send_error_json(400, f"body is not JSON: {error}")
            return
        sys.stderr.write("relay request: " + json.dumps(body, ensure_ascii=False) + "\n")
        sys.stderr.flush()
        try:
            chat = translate(body)
        except Rejected as error:
            self._send_error_json(400, str(error))
            return
        sys.stderr.write("relay upstream: " + json.dumps(chat, ensure_ascii=False) + "\n")
        sys.stderr.flush()

        request = urllib.request.Request(
            UPSTREAM_CHAT,
            data=json.dumps(chat).encode(),
            headers={"Content-Type": "application/json", "Authorization": "Bearer relay"},
        )
        try:
            upstream = urllib.request.urlopen(request, timeout=300)
        except Exception as error:  # noqa: BLE001 - surfaced to the client
            self._send_error_json(502, f"upstream failed: {error}")
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        state = {
            "created": False,
            "text_started": False,
            "text": "",
            "message_id": "msg_relay",
            "tools": {},  # openai index -> item
            "order": [],
            "usage": None,
            "finish": None,
        }

        def emit(event_type, payload):
            frame = {"type": event_type, **payload}
            self.wfile.write(
                f"event: {event_type}\ndata: {json.dumps(frame, ensure_ascii=False)}\n\n".encode()
            )
            self.wfile.flush()

        def ensure_created():
            if not state["created"]:
                state["created"] = True
                emit("response.created", {"response": {
                    "id": "resp_relay", "object": "response", "status": "in_progress",
                    "model": chat.get("model"), "output": [],
                }})

        def text_item():
            if not state["text_started"]:
                state["text_started"] = True
                state["order"].append(("message", 0))
                emit("response.output_item.added", {
                    "output_index": 0, "content_index": 0,
                    "item": {"type": "message", "id": state["message_id"],
                             "role": "assistant", "content": []},
                })
            return 0

        try:
            for raw_line in upstream:
                line = raw_line.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except ValueError:
                    continue
                if chunk.get("usage"):
                    state["usage"] = chunk["usage"]
                choice = (chunk.get("choices") or [{}])[0]
                delta = choice.get("delta") or {}
                content = delta.get("content")
                if content:
                    ensure_created()
                    index = text_item()
                    state["text"] += content
                    emit("response.output_text.delta", {
                        "item_id": state["message_id"], "output_index": index,
                        "content_index": 0, "delta": content,
                    })
                for call in delta.get("tool_calls") or []:
                    ensure_created()
                    slot = state["tools"].get(call.get("index", 0))
                    if slot is None:
                        name = (call.get("function") or {}).get("name") or ""
                        call_id = call.get("id") or f"call_relay_{call.get('index', 0)}"
                        item_index = 1 + len(state["tools"])
                        slot = {
                            "call_id": call_id, "name": name,
                            "arguments": "", "output_index": item_index,
                            "opened": False,
                        }
                        state["tools"][call.get("index", 0)] = slot
                        state["order"].append(("function_call", item_index))
                    # The name can arrive after the id, so announce as soon as it is known.
                    if not slot["opened"] and slot["name"]:
                        slot["opened"] = True
                        emit("response.output_item.added", {
                            "output_index": slot["output_index"],
                            "item": {
                                "type": "function_call", "id": "fc_relay_" + slot["call_id"],
                                "call_id": slot["call_id"], "name": slot["name"],
                                "arguments": "", "status": "in_progress",
                            },
                        })
                    arguments = (call.get("function") or {}).get("arguments")
                    if arguments:
                        slot["arguments"] += arguments
                        if slot["opened"]:
                            emit("response.function_call_arguments.delta", {
                                "output_index": slot["output_index"], "delta": arguments,
                            })
                if choice.get("finish_reason"):
                    state["finish"] = choice["finish_reason"]
        except Exception as error:  # noqa: BLE001 - the client sees a readable failure
            ensure_created()
            emit("response.failed", {"response": {
                "id": "resp_relay", "status": "failed",
                "error": {"message": f"relay upstream read failed: {error}"},
            }})
            return
        finally:
            try:
                upstream.close()
            except Exception:  # noqa: BLE001
                pass

        ensure_created()
        output = []
        if state["text_started"]:
            emit("response.output_text.done", {
                "item_id": state["message_id"], "output_index": 0,
                "content_index": 0, "text": state["text"],
            })
            emit("response.output_item.done", {
                "output_index": 0,
                "item": {"type": "message", "id": state["message_id"], "role": "assistant",
                         "status": "completed",
                         "content": [{"type": "output_text", "text": state["text"],
                                      "annotations": []}]},
            })
            output.append({"type": "message", "id": state["message_id"], "role": "assistant",
                           "status": "completed",
                           "content": [{"type": "output_text", "text": state["text"],
                                        "annotations": []}]})
        for slot in state["tools"].values():
            if not slot["opened"]:
                continue
            emit("response.output_item.done", {
                "output_index": slot["output_index"],
                "item": {"type": "function_call", "id": "fc_relay_" + slot["call_id"],
                         "call_id": slot["call_id"], "name": slot["name"],
                         "arguments": slot["arguments"] or "{}", "status": "completed"},
            })
            output.append({"type": "function_call", "id": "fc_relay_" + slot["call_id"],
                           "call_id": slot["call_id"], "name": slot["name"],
                           "arguments": slot["arguments"] or "{}", "status": "completed"})

        usage = state["usage"] or {}
        emit("response.completed", {"response": {
            "id": "resp_relay", "object": "response", "status": "completed",
            "model": chat.get("model"), "output": output,
            "usage": {
                "input_tokens": usage.get("prompt_tokens", 0),
                "input_tokens_details": {
                    "cached_tokens": (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0),
                },
                "output_tokens": usage.get("completion_tokens", 0),
                "output_tokens_details": {
                    "reasoning_tokens": (usage.get("completion_tokens_details") or {}).get("reasoning_tokens", 0),
                },
                "total_tokens": usage.get("total_tokens", 0),
            },
        }})
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main():
    global UPSTREAM_CHAT
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=28799)
    parser.add_argument("--upstream", default=UPSTREAM_CHAT)
    args = parser.parse_args()
    UPSTREAM_CHAT = args.upstream
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    sys.stderr.write(f"relay listening on http://127.0.0.1:{args.port}/v1 -> {UPSTREAM_CHAT}\n")
    sys.stderr.flush()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        thread.join()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
