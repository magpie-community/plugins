// Copy into Magpie's internal/gateway; set MAGPIE_IMAGE_PLUGIN_DIR and optionally MAGPIE_IMAGE_TEST_BUN.
package gateway

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/yetone/magpie/internal/plugin"
	"github.com/yetone/magpie/internal/provider"
	"github.com/yetone/magpie/internal/settings"
)

func TestCurrentTurnImagesHTTP(t *testing.T) {
	dir := os.Getenv("MAGPIE_IMAGE_PLUGIN_DIR")
	if dir == "" {
		t.Fatal("set MAGPIE_IMAGE_PLUGIN_DIR")
	}
	if bun := os.Getenv("MAGPIE_IMAGE_TEST_BUN"); bun != "" {
		t.Setenv("MAGPIE_BUN", bun)
	}
	dataDir := t.TempDir()
	var mu sync.Mutex
	var received string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		received = string(body)
		mu.Unlock()
		var request struct {
			Stream bool `json:"stream"`
		}
		if err := json.Unmarshal(body, &request); err != nil {
			t.Error(err)
		}
		if request.Stream {
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, sse(
				`data: {"id":"c1","model":"m1","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}`,
				`data: {"id":"c1","model":"m1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}`,
				`data: [DONE]`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"c1","object":"chat.completion","model":"m1","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}`)
	}))
	defer up.Close()
	fresh(t)
	t.Cleanup(plugin.Settle)
	if err := provider.Save(provider.Provider{ID: "fake", Name: "Fake", Key: "k", Models: []string{"m1"}, Chat: up.URL + "/v1"}); err != nil {
		t.Fatal(err)
	}
	list, _ := json.Marshal(plugin.List{Plugins: []plugin.Entry{{Spec: dir, Options: map[string]any{"dataDir": dataDir}}}})
	if err := os.MkdirAll(settings.Dir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(settings.Dir(), "plugins.json"), list, 0o644); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/v1/chat/completions", "/v1/messages", "/v1/responses", "/v1beta/models/fake/m1:generateContent"} {
		t.Run(path, func(t *testing.T) {
			mu.Lock()
			received = ""
			mu.Unlock()
			var body string
			switch path {
			case "/v1/chat/completions":
				body = `{"model":"fake/m1","messages":[{"role":"user","content":[{"type":"text","text":"old text"},{"type":"image_url","image_url":{"url":"https://example.invalid/OLD"}}]},{"role":"assistant","tool_calls":[{"id":"old_call","type":"function","function":{"name":"screen","arguments":"{}"}}]},{"role":"tool","tool_call_id":"old_call","content":[{"type":"text","text":"old tool text"},{"type":"image_url","image_url":{"url":"https://example.invalid/OLD_TOOL"}}]},{"role":"assistant","content":"ok"},{"role":"user","content":[{"type":"text","text":"now"},{"type":"image_url","image_url":{"url":"https://example.invalid/NEW"}}]},{"role":"assistant","tool_calls":[{"id":"new_call","type":"function","function":{"name":"screen","arguments":"{}"}}]},{"role":"tool","tool_call_id":"new_call","content":[{"type":"text","text":"new tool text"},{"type":"image_url","image_url":{"url":"https://example.invalid/NEW_TOOL"}}]}]}`
			case "/v1/messages":
				body = `{"model":"fake/m1","max_tokens":10,"messages":[{"role":"user","content":[{"type":"text","text":"old text"},{"type":"image","source":{"type":"url","url":"https://example.invalid/OLD"}}]},{"role":"assistant","content":[{"type":"tool_use","id":"old_call","name":"screen","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"old_call","content":[{"type":"text","text":"old tool text"},{"type":"image","source":{"type":"url","url":"https://example.invalid/OLD_TOOL"}}]}]},{"role":"assistant","content":"ok"},{"role":"user","content":[{"type":"text","text":"now"},{"type":"image","source":{"type":"url","url":"https://example.invalid/NEW"}}]},{"role":"assistant","content":[{"type":"tool_use","id":"new_call","name":"screen","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"new_call","content":[{"type":"text","text":"new tool text"},{"type":"image","source":{"type":"url","url":"https://example.invalid/NEW_TOOL"}}]}]}]}`
			case "/v1/responses":
				body = `{"model":"fake/m1","input":[{"role":"user","content":[{"type":"input_text","text":"old text"},{"type":"input_image","image_url":"https://example.invalid/OLD"}]},{"type":"function_call","call_id":"old_call","name":"screen","arguments":"{}"},{"type":"function_call_output","call_id":"old_call","output":[{"type":"input_text","text":"old tool text"},{"type":"input_image","image_url":"https://example.invalid/OLD_TOOL"}]},{"role":"assistant","content":"ok"},{"role":"user","content":[{"type":"input_text","text":"now"},{"type":"input_image","image_url":"https://example.invalid/NEW"}]},{"type":"function_call","call_id":"new_call","name":"screen","arguments":"{}"},{"type":"function_call_output","call_id":"new_call","output":[{"type":"input_text","text":"new tool text"},{"type":"input_image","image_url":"https://example.invalid/NEW_TOOL"}]}]}`
			case "/v1beta/models/fake/m1:generateContent":
				body = `{"contents":[{"role":"user","parts":[{"text":"old text"},{"fileData":{"mimeType":"image/png","fileUri":"https://example.invalid/OLD"}}]},{"role":"model","parts":[{"functionCall":{"name":"screen","args":{}}}]},{"role":"user","parts":[{"functionResponse":{"name":"screen","response":{"text":"old tool text"}}},{"fileData":{"mimeType":"image/png","fileUri":"https://example.invalid/OLD_TOOL"}}]},{"role":"model","parts":[{"text":"ok"}]},{"role":"user","parts":[{"text":"now"},{"fileData":{"mimeType":"image/png","fileUri":"https://example.invalid/NEW"}}]},{"role":"model","parts":[{"functionCall":{"name":"screen","args":{}}}]},{"role":"user","parts":[{"functionResponse":{"name":"screen","response":{"text":"new tool text"}}},{"fileData":{"mimeType":"image/png","fileUri":"https://example.invalid/NEW_TOOL"}}]}]}`
			}
			status, reply := post(t, path, body)
			if status != 200 {
				t.Fatalf("HTTP %d %s", status, reply)
			}
			mu.Lock()
			sent := received
			mu.Unlock()
			if strings.Contains(sent, "/OLD") || strings.Contains(sent, `https://example.invalid/NEW"`) || !strings.Contains(sent, "/NEW_TOOL") || !strings.Contains(sent, "old text") || !strings.Contains(sent, "old tool text") {
				t.Fatalf("upstream received %s", sent)
			}
			if !strings.Contains(reply, "ok") {
				t.Fatalf("unexpected response %s", reply)
			}
			// Another inference request within the same user task: no new image.
			var follow map[string]any
			if err := json.Unmarshal([]byte(body), &follow); err != nil {
				t.Fatal(err)
			}
			key := "messages"
			var call, result any
			switch path {
			case "/v1/chat/completions":
				call = map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"id": "text_call", "type": "function", "function": map[string]any{"name": "screen", "arguments": "{}"}}}}
				result = map[string]any{"role": "tool", "tool_call_id": "text_call", "content": "text-only tool result"}
			case "/v1/messages":
				call = map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "tool_use", "id": "text_call", "name": "screen", "input": map[string]any{}}}}
				result = map[string]any{"role": "user", "content": []any{map[string]any{"type": "tool_result", "tool_use_id": "text_call", "content": "text-only tool result"}}}
			case "/v1/responses":
				key = "input"
				call = map[string]any{"type": "function_call", "call_id": "text_call", "name": "screen", "arguments": "{}"}
				result = map[string]any{"type": "function_call_output", "call_id": "text_call", "output": "text-only tool result"}
			default:
				key = "contents"
				call = map[string]any{"role": "model", "parts": []any{map[string]any{"functionCall": map[string]any{"name": "screen", "args": map[string]any{}}}}}
				result = map[string]any{"role": "user", "parts": []any{map[string]any{"functionResponse": map[string]any{"name": "screen", "response": map[string]any{"text": "text-only tool result"}}}}}
			}
			follow[key] = append(follow[key].([]any), call, result)
			encoded, err := json.Marshal(follow)
			if err != nil {
				t.Fatal(err)
			}
			status, reply = post(t, path, string(encoded))
			if status != 200 {
				t.Fatalf("no-image followup HTTP %d %s", status, reply)
			}
			mu.Lock()
			sent = received
			mu.Unlock()
			if strings.Contains(sent, "https://example.invalid/") || !strings.Contains(sent, "text-only tool result") {
				t.Fatalf("no-image request retained older images: %s", sent)
			}
		})
	}
	states := plugin.GatewayStates(t.Context())
	state, ok := states[dir]
	if !ok || state.Failures != 0 || state.Calls != 8 {
		t.Fatalf("request hook state %+v", states)
	}
	files, err := filepath.Glob(filepath.Join(dataDir, "*.jsonl"))
	if err != nil || len(files) != 1 {
		t.Fatalf("missing journal: %v %v", files, err)
	}
	journal, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(journal)), "\n")
	if len(lines) != 8 {
		t.Fatalf("got %d records", len(lines))
	}
	for index, line := range lines {
		var row struct {
			RemovedImages int `json:"removedImages"`
			KeptImages    int `json:"keptCurrentImages"`
			Before        int `json:"requestBytesBefore"`
			After         int `json:"requestBytesAfter"`
		}
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			t.Fatal(err)
		}
		wantRemoved, wantKept := 3, 1
		if index%2 == 1 {
			wantRemoved, wantKept = 4, 0
		}
		if row.RemovedImages != wantRemoved || row.KeptImages != wantKept || row.Before <= row.After {
			t.Fatalf("unexpected metrics %s", line)
		}
	}
}
