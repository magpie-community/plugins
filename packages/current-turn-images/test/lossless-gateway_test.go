// Copy into Magpie's internal/gateway; set MAGPIE_IMAGE_PLUGIN_DIR and optionally MAGPIE_IMAGE_TEST_BUN.
package gateway

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/yetone/magpie/internal/plugin"
	"github.com/yetone/magpie/internal/provider"
	"github.com/yetone/magpie/internal/settings"
)

func TestLosslessImagesHTTP(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("bundled native codecs are Windows x64 only")
	}
	dir := os.Getenv("MAGPIE_IMAGE_PLUGIN_DIR")
	if dir == "" {
		t.Fatal("set MAGPIE_IMAGE_PLUGIN_DIR")
	}
	if bun := os.Getenv("MAGPIE_IMAGE_TEST_BUN"); bun != "" {
		t.Setenv("MAGPIE_BUN", bun)
	}
	formats := []struct{ ext, mime string }{{"png", "image/png"}, {"jpg", "image/jpeg"}, {"gif", "image/gif"}, {"webp", "image/webp"}}
	var images [][]byte
	for _, format := range formats {
		data, err := os.ReadFile(filepath.Join(dir, "test", "compression-fixtures", "large."+format.ext))
		if err != nil {
			t.Fatal(err)
		}
		images = append(images, data)
	}
	dataDir := t.TempDir()
	var mu sync.Mutex
	var received []byte
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		received = body
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, sse(
			`data: {"id":"c1","model":"m1","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"}}]}`,
			`data: {"id":"c1","model":"m1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}`,
			`data: [DONE]`))
	}))
	defer up.Close()
	fresh(t)
	t.Cleanup(plugin.Settle)
	if err := provider.Save(provider.Provider{ID: "fake", Name: "Fake", Key: "k", Models: []string{"m1"}, Chat: up.URL + "/v1"}); err != nil {
		t.Fatal(err)
	}
	options := map[string]any{"dataDir": dataDir, "gatewayTimeoutMs": 10000, "imageCompression": map[string]any{"maxMilliseconds": 6000, "toolMilliseconds": 3000}}
	list, _ := json.Marshal(plugin.List{Plugins: []plugin.Entry{{Spec: dir, Options: options}}})
	if err := os.MkdirAll(settings.Dir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(settings.Dir(), "plugins.json"), list, 0o644); err != nil {
		t.Fatal(err)
	}
	for _, protocol := range []string{"chat", "responses", "anthropic", "gemini"} {
		t.Run(protocol, func(t *testing.T) {
			parts := []any{map[string]any{"type": "text", "text": "Lossless fixture images"}}
			for index, format := range formats {
				encoded := base64.StdEncoding.EncodeToString(images[index])
				var part any
				switch protocol {
				case "chat":
					part = map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:" + format.mime + ";base64," + encoded}}
				case "responses":
					part = map[string]any{"type": "input_image", "image_url": "data:" + format.mime + ";base64," + encoded}
				case "anthropic":
					part = map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": format.mime, "data": encoded}}
				default:
					part = map[string]any{"inlineData": map[string]any{"mimeType": format.mime, "data": encoded}}
				}
				parts = append(parts, part)
			}
			path, key, contentKey := "/v1/chat/completions", "messages", "content"
			switch protocol {
			case "responses":
				path, key = "/v1/responses", "input"
				parts[0] = map[string]any{"type": "input_text", "text": "Lossless fixture images"}
			case "anthropic":
				path = "/v1/messages"
			case "gemini":
				path, key, contentKey = "/v1beta/models/fake/m1:generateContent", "contents", "parts"
				parts[0] = map[string]any{"text": "Lossless fixture images"}
			}
			body, _ := json.Marshal(map[string]any{"model": "fake/m1", "max_tokens": 100, key: []any{map[string]any{"role": "user", contentKey: parts}}})
			status, reply := post(t, path, string(body))
			if status != 200 || !strings.Contains(reply, "OK") {
				t.Fatalf("HTTP %d %s", status, reply)
			}
			mu.Lock()
			actual := append([]byte(nil), received...)
			mu.Unlock()
			var sent map[string]any
			if err := json.Unmarshal(actual, &sent); err != nil {
				t.Fatal(err)
			}
			var urls []string
			for _, message := range sent["messages"].([]any) {
				content, ok := message.(map[string]any)["content"].([]any)
				if !ok {
					continue
				}
				for _, part := range content {
					p := part.(map[string]any)
					if p["type"] == "image_url" {
						urls = append(urls, p["image_url"].(map[string]any)["url"].(string))
					}
				}
			}
			if len(urls) != 4 {
				t.Fatalf("upstream received %d images: %s", len(urls), actual)
			}
			for index, url := range urls {
				data, err := base64.StdEncoding.DecodeString(strings.SplitN(url, ",", 2)[1])
				if err != nil || len(data) >= len(images[index]) {
					t.Fatalf("%s image was not compressed: %d -> %d, %v", formats[index].ext, len(images[index]), len(data), err)
				}
				if output := os.Getenv("MAGPIE_PIXEL_EVIDENCE_DIR"); output != "" {
					if err := os.MkdirAll(output, 0o755); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(filepath.Join(output, "http-"+protocol+"."+formats[index].ext), data, 0o600); err != nil {
						t.Fatal(err)
					}
				}
			}
		})
	}
	files, _ := filepath.Glob(filepath.Join(dataDir, "*.jsonl"))
	if len(files) != 1 {
		t.Fatal("compression journal missing")
	}
	journal, _ := os.ReadFile(files[0])
	for _, line := range strings.Split(strings.TrimSpace(string(journal)), "\n") {
		var record struct {
			Compressed int `json:"compressedImages"`
			Saved      int `json:"compressionSavedRequestBytes"`
			Before     int `json:"requestBytesBefore"`
			After      int `json:"requestBytesAfter"`
		}
		if err := json.Unmarshal([]byte(line), &record); err != nil || record.Compressed != 4 || record.Saved != record.Before-record.After || record.Saved <= 0 {
			t.Fatalf("unexpected compression measurement: %s", line)
		}
	}
}
