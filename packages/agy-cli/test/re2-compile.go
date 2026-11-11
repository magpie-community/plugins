// Helper for re2-pattern-unit.mjs: compile each stdin JSON line's "pattern"
// with Go's regexp (RE2) and print whether it succeeded.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
)

type req struct {
	Pattern string `json:"pattern"`
}

type res struct {
	Pattern string `json:"pattern"`
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
	Match   *bool  `json:"match,omitempty"`
	Input   string `json:"input,omitempty"`
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	// Patterns can be long; raise the limit.
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	out := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var r req
		var extra struct {
			Pattern string `json:"pattern"`
			Input   string `json:"input"`
		}
		if err := json.Unmarshal(line, &extra); err != nil {
			fmt.Fprintf(os.Stderr, "bad json: %v\n", err)
			os.Exit(1)
		}
		r.Pattern = extra.Pattern
		re, err := regexp.Compile(r.Pattern)
		row := res{Pattern: r.Pattern, OK: err == nil}
		if err != nil {
			row.Error = err.Error()
		} else if extra.Input != "" || (err == nil && jsonHasInput(line)) {
			matched := re.MatchString(extra.Input)
			row.Match = &matched
			row.Input = extra.Input
		}
		if err := out.Encode(row); err != nil {
			fmt.Fprintf(os.Stderr, "encode: %v\n", err)
			os.Exit(1)
		}
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "stdin: %v\n", err)
		os.Exit(1)
	}
}

func jsonHasInput(line []byte) bool {
	var m map[string]any
	if json.Unmarshal(line, &m) != nil {
		return false
	}
	_, ok := m["input"]
	return ok
}
