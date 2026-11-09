// Copy into Magpie's internal/middleware directory to run against its real engine.
package middleware

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/plugin"
)

func TestCurrentTurnImagesLog(t *testing.T) {
	dir := os.Getenv("MAGPIE_IMAGE_PLUGIN_DIR")
	if dir == "" {
		t.Fatal("set MAGPIE_IMAGE_PLUGIN_DIR")
	}
	spec := filepath.Join(dir, "current-turn-images.middleware.js")
	use(t, plugin.Entry{Spec: spec})
	var recorded bytes.Buffer
	original := log.Writer()
	log.SetOutput(&recorded)
	t.Cleanup(func() { log.SetOutput(original) })
	r := Begin(Info{Protocol: "chat", Model: "test/model"})
	if r == nil {
		t.Fatalf("plugin did not load: %+v", States())
	}
	defer r.End()
	request := []byte(`{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"SECRET_OLD_A"}},{"type":"image_url","image_url":{"url":"SECRET_OLD_B"}}]},{"role":"assistant","content":"ok"},{"role":"user","content":[{"type":"text","text":"SECRET_TEXT"},{"type":"image_url","image_url":{"url":"SECRET_OLD_C"}}]},{"role":"assistant","content":"ok"},{"role":"user","content":[{"type":"image_url","image_url":{"url":"SECRET_NEW"}}]}]}`)
	result, rejected := r.Request(request)
	if rejected != nil || strings.Contains(string(result), "SECRET_OLD") || !strings.Contains(string(result), "SECRET_NEW") {
		t.Fatal("unexpected image filtering")
	}
	line := recorded.String()
	index := strings.Index(line, "[current-turn-images] ")
	if index < 0 {
		t.Fatalf("no image record: %s", line)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(line[index+len("[current-turn-images] "):])), &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"protocol": "chat", "removedImages": float64(3), "affectedMessages": float64(2), "placeholderMessages": float64(1), "keptCurrentImages": float64(1)}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("image record %v, want %v", got, want)
	}
	if strings.Contains(line, "SECRET_") {
		t.Fatal("image record contains request content")
	}
	if state := States()[spec]; state.Error != "" || state.Failures != 0 {
		t.Fatalf("middleware failed: %+v", state)
	}
}

func TestCurrentTurnImages(t *testing.T) {
	dir := os.Getenv("MAGPIE_IMAGE_PLUGIN_DIR")
	if dir == "" {
		t.Fatal("set MAGPIE_IMAGE_PLUGIN_DIR to the plugin directory")
	}
	var fixtures []struct {
		Name     string          `json:"name"`
		Protocol string          `json:"protocol"`
		Request  json.RawMessage `json:"request"`
		Expected json.RawMessage `json:"expected"`
	}
	raw, err := os.ReadFile(filepath.Join(dir, "test", "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, spec := range []string{filepath.Join(dir, "current-turn-images.middleware.js")} {
		t.Run(filepath.Base(spec), func(t *testing.T) {
			use(t, plugin.Entry{Spec: spec})
			for _, fixture := range fixtures {
				t.Run(fixture.Name, func(t *testing.T) {
					r := Begin(Info{Protocol: fixture.Protocol, Model: "test/model"})
					if r == nil {
						t.Fatalf("middleware did not load: %+v", States())
					}
					defer r.End()
					got, rejected := r.Request(fixture.Request)
					if rejected != nil {
						t.Fatal(rejected)
					}
					var actual, expected any
					if err := json.Unmarshal(got, &actual); err != nil {
						t.Fatal(err)
					}
					if err := json.Unmarshal(fixture.Expected, &expected); err != nil {
						t.Fatal(err)
					}
					if !reflect.DeepEqual(actual, expected) {
						t.Fatalf("got %s, want %s", got, fixture.Expected)
					}
				})
			}
			// Exercise pool reuse under concurrent requests with different content.
			var wg sync.WaitGroup
			for index := 0; index < 24; index++ {
				wg.Add(1)
				go func(index int) {
					defer wg.Done()
					fixture := fixtures[index%len(fixtures)]
					r := Begin(Info{Protocol: fixture.Protocol, Model: "test/model"})
					if r == nil {
						t.Error("missing concurrent runtime")
						return
					}
					defer r.End()
					got, rejected := r.Request(fixture.Request)
					var actual, expected any
					json.Unmarshal(got, &actual)
					json.Unmarshal(fixture.Expected, &expected)
					if rejected != nil || !reflect.DeepEqual(actual, expected) {
						t.Errorf("concurrent request %d failed", index)
					}
				}(index)
			}
			wg.Wait()
			for _, size := range []int{1 << 20, 8 << 20} {
				t.Run(fmt.Sprintf("payload-%d-MiB", size>>20), func(t *testing.T) {
					request := []byte(`{"model":"test/model","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,` + strings.Repeat("A", size) + `"}}]},{"role":"assistant","content":"ok"},{"role":"user","content":"now"}]}`)
					r := Begin(Info{Protocol: "chat", Model: "test/model"})
					defer r.End()
					start := time.Now()
					got, rejected := r.Request(request)
					t.Logf("%d bytes, %v", len(request), time.Since(start))
					if rejected != nil || strings.Contains(string(got), "data:image/png") {
						t.Fatal("large historical image was not removed")
					}
				})
			}
			if state := States()[spec]; state.Error != "" || state.Failures != 0 {
				t.Fatalf("runtime failures: %+v", state)
			}
		})
	}
}
