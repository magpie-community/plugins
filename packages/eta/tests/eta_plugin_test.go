package agent

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/yetone/magpie/internal/agentplug"
	"github.com/yetone/magpie/internal/gateway"
	"github.com/yetone/magpie/internal/plugin"
	"github.com/yetone/magpie/internal/provider"
)

// Run in an unmodified writable Magpie checkout; all user data is in t.TempDir.
func etaPluginHome(t *testing.T) (*Agent, string) {
	t.Helper()
	home := pluggedHome(t)
	spec := os.Getenv("ETA_MAGPIE_PLUGIN")
	if spec == "" {
		t.Fatal("ETA_MAGPIE_PLUGIN must name the absolute plugin package directory")
	}
	if _, err := plugin.Add(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	agentplug.Reload()
	a, err := Find("eta")
	if err != nil {
		t.Fatal(err)
	}
	if a.Plugin != spec || !a.ListsModels || !a.Detected() {
		t.Fatalf("not a detected connect-only plugin: %+v", a)
	}
	if a.Path != filepath.Join(home, ".config", "eta", "magpie.json") {
		t.Fatal(a.Path)
	}
	if plugin.InstalledName(spec) != "Eta" || plugin.InstalledIcon(spec) == "" || a.Icon == "" {
		t.Fatalf("missing package/agent branding: name=%q icon=%q agentIcon=%q", plugin.InstalledName(spec), plugin.InstalledIcon(spec), a.Icon)
	}
	if !plugin.InMagpieOnly(spec) {
		t.Fatal("must not load a Node/provider entry point")
	}
	return a, spec
}

func etaPluginRead(t *testing.T, a *Agent) map[string]any {
	t.Helper()
	b, err := os.ReadFile(a.Path)
	if err != nil {
		t.Fatal(err)
	}
	var c map[string]any
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func TestEtaPluginLifecycle(t *testing.T) {
	a, _ := etaPluginHome(t)
	os.MkdirAll(filepath.Dir(a.Path), 0700)
	original := []byte(`{"version":1,"baseUrl":"http://127.0.0.1:9","apiKey":"previous-key","keep":{"mine":true}}`)
	if err := os.WriteFile(a.Path, original, 0600); err != nil {
		t.Fatal(err)
	}
	if err := a.Connect(); err != nil {
		t.Fatal(err)
	}
	c := etaPluginRead(t, a)
	if c["version"] != float64(1) || c["baseUrl"] != gateway.URL() || c["apiKey"] != gateway.TokenFor("eta") || c["keep"] == nil {
		t.Fatalf("bad config: %v", c)
	}
	if err := a.Sync(); err != nil {
		t.Fatal(err)
	}
	agentplug.Reload()
	reopened, err := Find("eta")
	if err != nil || !reopened.Wired() {
		t.Fatalf("reopen: %v %v", reopened, err)
	}
	if err := reopened.Disconnect(); err != nil {
		t.Fatal(err)
	}
	c = etaPluginRead(t, a)
	if c["baseUrl"] != "http://127.0.0.1:9" || c["apiKey"] != "previous-key" || c["keep"] == nil {
		t.Fatalf("not restored: %v", c)
	}
}

func TestEtaPluginRemovalAndManualKey(t *testing.T) {
	for _, changed := range []bool{false, true} {
		t.Run(map[bool]string{false: "remove", true: "manual-key"}[changed], func(t *testing.T) {
			a, spec := etaPluginHome(t)
			if err := a.Connect(); err != nil {
				t.Fatal(err)
			}
			c := etaPluginRead(t, a)
			c["unrelated"] = "keep"
			if changed {
				c["apiKey"] = "user-key"
			}
			b, _ := json.Marshal(c)
			if err := os.WriteFile(a.Path, b, 0600); err != nil {
				t.Fatal(err)
			}
			if err := provider.RemovePlugin(context.Background(), spec); err != nil {
				t.Fatal(err)
			}
			agentplug.Reload()
			c = etaPluginRead(t, a)
			if c["unrelated"] != "keep" {
				t.Fatal(c)
			}
			if changed && c["apiKey"] != "user-key" {
				t.Fatal("overwrote manual connection")
			}
			if !changed && (c["apiKey"] != nil || c["baseUrl"] != nil || c["version"] != nil) {
				t.Fatalf("plugin still wired: %v", c)
			}
			if _, err := Find("eta"); err == nil {
				t.Fatal("removed plugin still listed")
			}
		})
	}
}

func TestEtaPluginCatalog(t *testing.T) {
	a, _ := etaPluginHome(t)
	if err := provider.SetHiddenModels("eta", []string{"deepseek/flash"}); err != nil {
		t.Fatal(err)
	}
	if err := a.Connect(); err != nil {
		t.Fatal(err)
	}
	c := etaPluginRead(t, a)
	list := func(key string) map[string]bool {
		r := httptest.NewRequest("GET", "/v1/models", nil)
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("Authorization", "Bearer "+key)
		w := httptest.NewRecorder()
		gateway.New().Handler().ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("catalog: %d %s", w.Code, w.Body.String())
		}
		var result struct{ Data []struct{ ID string } }
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		out := map[string]bool{}
		for _, m := range result.Data {
			out[m.ID] = true
		}
		return out
	}
	eta := list(c["apiKey"].(string))
	other := list(gateway.TokenFor("cursor"))
	if !eta["deepseek/pro"] || eta["deepseek/flash"] || !other["deepseek/flash"] {
		t.Fatalf("eta=%v other=%v", eta, other)
	}
}

func TestEtaPluginPortSync(t *testing.T) {
	a, _ := etaPluginHome(t)
	t.Setenv("MAGPIE_ADDR", "")
	setPort(t, 3425)
	if err := a.Connect(); err != nil {
		t.Fatal(err)
	}
	setPort(t, 5432)
	// The current host compares plugin strings to its stash, not the new URL.
	// Exercise that path before the explicit reapply workaround.
	if _, err := Rewire([]*Agent{a}); err != nil {
		t.Fatal(err)
	}
	if c := etaPluginRead(t, a); c["baseUrl"] != "http://127.0.0.1:3425" {
		t.Fatalf("host port behavior changed; revisit the documented workaround: %v", c)
	}
	// Reapply Eta in Magpie after changing ports; Sync writes the current URL.
	if err := a.Sync(); err != nil {
		t.Fatal(err)
	}
	if c := etaPluginRead(t, a); c["baseUrl"] != gateway.URL() {
		t.Fatalf("stale address: %v", c)
	}
	if err := a.Disconnect(); err != nil {
		t.Fatal(err)
	}
	if c := etaPluginRead(t, a); len(c) != 0 {
		t.Fatalf("not disconnected: %v", c)
	}
}

func TestEtaPluginOffOnAndStandalone(t *testing.T) {
	a, spec := etaPluginHome(t)
	if err := a.Connect(); err != nil {
		t.Fatal(err)
	}
	if err := provider.SetPluginOff(context.Background(), spec, true); err != nil {
		t.Fatal(err)
	}
	agentplug.Reload()
	if c := etaPluginRead(t, a); len(c) != 0 {
		t.Fatalf("off retained connection: %v", c)
	}
	if err := provider.SetPluginOff(context.Background(), spec, false); err != nil {
		t.Fatal(err)
	}
	agentplug.Reload()
	reopened, err := Find("eta")
	if err != nil || reopened.Wired() {
		t.Fatalf("on must not silently reconnect: %v", err)
	}
	if err := reopened.Connect(); err != nil {
		t.Fatal(err)
	}
	if err := provider.RemovePlugin(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	standalone := filepath.Join(spec, "eta.agent.mjs")
	if _, err := plugin.Add(context.Background(), standalone); err != nil {
		t.Fatal(err)
	}
	agentplug.Reload()
	reopened, err = Find("eta")
	if err != nil {
		t.Fatal(err)
	}
	if err := reopened.Connect(); err != nil {
		t.Fatal(err)
	}
	if c := etaPluginRead(t, reopened); c["apiKey"] != gateway.TokenFor("eta") {
		t.Fatal(c)
	}
	if err := provider.RemovePlugin(context.Background(), standalone); err != nil {
		t.Fatal(err)
	}
}
