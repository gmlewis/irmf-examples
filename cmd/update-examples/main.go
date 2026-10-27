// update-examples parses the README.md files in the examples directory and
// updates the code snippets with minimal versions of the shaders, because
// there is no good way to embed files into README.md files on GitHub.
//
// For each `## <base>.irmf` section it emits every available language variant
// (GLSL, WGSL, TSL) and a one-click link to open that variant in the IRMF
// editor.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var (
	h2RE          = regexp.MustCompile(`\n##\s+`)
	irmfTokenRE   = regexp.MustCompile(`([A-Za-z0-9_+.\-]+\.irmf)`)
	languageRE    = regexp.MustCompile(`(?m)^\s*"?language"?\s*:\s*"([^"]+)"`)
	checkOnly     = flag.Bool("check", false, "exit non-zero if a README would change")
	driftDetected = false
)

var (
	languageOrder = []string{"glsl", "wgsl", "tsl"}
	languageLabel = map[string]string{"glsl": "GLSL", "wgsl": "WGSL", "tsl": "TSL"}
)

type irmfFile struct {
	text string
	lang string
}

func main() {
	flag.Parse()

	readmeByPath := map[string]string{}
	irmfByPath := map[string]map[string]irmfFile{}
	dlpFileSizesByPath := map[string]map[string]int64{}
	if err := filepath.Walk("examples", func(path string, info os.FileInfo, err error) error {
		if err != nil {
			log.Fatalf("path=%q, err=%v", path, err)
		}
		if info.IsDir() {
			irmfByPath[path] = map[string]irmfFile{}
			dlpFileSizesByPath[path] = map[string]int64{}
			return nil
		}
		dir := filepath.Dir(path)
		base := filepath.Base(path)
		switch {
		case base == "README.md":
			buf, err := os.ReadFile(path)
			if err != nil {
				return fmt.Errorf("ReadFile(%q): %v", path, err)
			}
			readmeByPath[dir] = string(buf)
		case strings.HasSuffix(base, ".cbddlp"):
			dlpFileSizesByPath[dir][base] = info.Size()
		case strings.HasSuffix(base, ".irmf"):
			buf, err := os.ReadFile(path)
			if err != nil {
				return fmt.Errorf("ReadFile(%q): %v", path, err)
			}
			irmfByPath[dir][base] = irmfFile{
				text: removeExtraFields(string(buf)),
				lang: fileLanguage(base, string(buf)),
			}
		}
		return nil
	}); err != nil {
		log.Fatalf("filepath.Walk: %v", err)
	}

	for k, v := range readmeByPath {
		processReadme(k, v, irmfByPath[k], dlpFileSizesByPath[k])
	}

	if *checkOnly && driftDetected {
		log.Fatal("one or more README.md files are out of date; run this program without -check")
	}
}

func fileLanguage(name, raw string) string {
	switch {
	case strings.HasSuffix(name, "-wgsl.irmf"):
		return "wgsl"
	case strings.HasSuffix(name, "-tsl.irmf"):
		return "tsl"
	case strings.HasSuffix(name, "-glsl.irmf"):
		return "glsl"
	}
	if m := languageRE.FindStringSubmatch(raw); len(m) > 1 {
		lang := strings.ToLower(strings.TrimSpace(m[1]))
		if _, ok := languageLabel[lang]; ok {
			return lang
		}
	}
	return "glsl"
}

func baseName(name string) string {
	n := strings.TrimSuffix(name, ".irmf")
	for _, suffix := range []string{"-glsl", "-wgsl", "-tsl"} {
		if strings.HasSuffix(n, suffix) {
			return strings.TrimSuffix(n, suffix)
		}
	}
	return n
}

func removeExtraFields(s string) string {
	lines := strings.Split(s, "\n")
	inJSON := true
	var out []string
	for i, line := range lines {
		if i == 0 {
			out = append(out, line)
			continue
		}
		if !inJSON {
			out = append(out, line)
			continue
		}
		if line == "}*/" {
			inJSON = false
			out = append(out, line)
			continue
		}
		matched := false
		for _, key := range fieldsToKeep {
			for _, tag := range []string{`"` + key + `": `, key + `: `} {
				if index := strings.Index(line, tag); index >= 0 {
					out = append(out, "  "+key+": "+line[index+len(tag):])
					matched = true
					break
				}
			}
			if matched {
				break
			}
		}
	}
	return strings.Join(out, "\n")
}

// variantsFor maps each language to the file name that provides it.
func variantsFor(base string, files map[string]irmfFile) map[string]string {
	out := map[string]string{}
	for _, lang := range languageOrder {
		for _, candidate := range []string{base + "-" + lang + ".irmf", base + ".irmf"} {
			if f, ok := files[candidate]; ok && f.lang == lang {
				out[lang] = candidate
				break
			}
		}
	}
	// Fall back to any name for the same base and language.
	for name, f := range files {
		if strings.Contains(name, "-gzip") || strings.Contains(name, "-base64") {
			continue
		}
		if baseName(name) != base {
			continue
		}
		if _, ok := out[f.lang]; !ok {
			out[f.lang] = name
		}
	}
	return out
}

func processReadme(path, buf string, irmfs map[string]irmfFile, dlpFileSizes map[string]int64) {
	log.Printf("Processing %v/README.md ...", path)
	log.Printf("Found %v .irmf files...", len(irmfs))

	licenseText := newLicenseText

	parts := h2RE.Split(buf, -1)
	for i, v := range parts {
		if i == 0 {
			continue
		}
		m := irmfTokenRE.FindStringSubmatch(v)
		if m == nil {
			parts[i] = "## " + v
			continue
		}
		name := m[1]
		base := baseName(name)
		if strings.Contains(name, "-gzip") || strings.Contains(name, "-base64") {
			parts[i] = "## " + v
			continue
		}
		if j := strings.Index(v, "-----"); j >= 0 {
			licenseText = v[j:] // Preserve the year of the original license text.
			v = v[:j]
		}

		variants := variantsFor(base, irmfs)
		if len(variants) == 0 {
			log.Printf("Warning: no .irmf variants found for %v", name)
			parts[i] = "## " + v
			continue
		}

		// Strip the old messages if the section has no code fence.
		if j := strings.Index(v, "* Try loading"); j >= 0 {
			v = v[:j]
		}
		if j := strings.Index(v, "* Use [irmf-slicer]"); j >= 0 {
			v = v[:j]
		}
		// Preserve the prose and image; replace the old code block onward.
		head := v
		if j := strings.Index(v, "```"); j >= 0 {
			head = v[:j]
		}
		// Remove any language labels left by a previous run.
		head = strings.TrimRight(head, "\n")
		for {
			lines := strings.Split(head, "\n")
			if len(lines) == 0 {
				break
			}
			last := strings.TrimSpace(lines[len(lines)-1])
			if last == "" || last == "**GLSL**" || last == "**WGSL**" || last == "**TSL**" {
				head = strings.Join(lines[:len(lines)-1], "\n")
				continue
			}
			break
		}
		head += "\n"

		var b strings.Builder
		b.WriteString("## " + head)
		for _, lang := range languageOrder {
			filename, ok := variants[lang]
			if !ok {
				continue
			}
			text := strings.TrimRight(irmfs[filename].text, "\n") + "\n"
			if len(text) > 65536 {
				// Generated/encoded bodies can be very large; link instead.
				fmt.Fprintf(&b, "\n**%s**\n\nThe full source is large (%d bytes); see [%s](%s).\n",
					languageLabel[lang], len(text), filename, filename)
			} else {
				fmt.Fprintf(&b, "\n**%s**\n\n```%s\n%s```\n", languageLabel[lang], lang, text)
			}
		}
		b.WriteString("\n")
		for _, lang := range languageOrder {
			filename, ok := variants[lang]
			if !ok {
				continue
			}
			b.WriteString(tryMessage(path, filename, lang))
		}
		b.WriteString(addSlicerMessage())
		if len(dlpFileSizes) > 0 {
			b.WriteString(addDLPs(base+".irmf", dlpFileSizes))
		}
		parts[i] = b.String()
	}
	parts = append(parts, licenseText)

	outbuf := []byte(strings.Join(parts, "\n"))
	target := path + "/README.md"
	if *checkOnly {
		existing, err := os.ReadFile(target)
		if err != nil || string(existing) != string(outbuf) {
			log.Printf("Out of date: %v", target)
			driftDetected = true
		}
		return
	}
	if err := os.WriteFile(target, outbuf, 0644); err != nil {
		log.Fatalf("WriteFile: %v", err)
	}
}

func addSlicerMessage() string {
	return "\n* Use [irmf-slicer](https://github.com/gmlewis/irmf-slicer) to generate an STL or voxel approximation.\n"
}

func addDLPs(filename string, dlpFileSizes map[string]int64) string {
	var lines []string
	filename = strings.TrimSuffix(filename, ".irmf")
	for k, v := range dlpFileSizes {
		if strings.HasPrefix(k, filename+"-mat") {
			lines = append(lines, fmt.Sprintf("  - [%v](%v) (%v bytes)", k, k, v))
		}
	}
	if len(lines) == 0 {
		return ""
	}
	header := "* Here is a voxel approximation of this model\n  using [irmf-slicer](https://github.com/gmlewis/irmf-slicer)"
	if len(lines) > 1 {
		sort.Strings(lines)
		header += "\n  (one .cbddlp file per material)"
	}
	return "\n" + header + ":\n" + strings.Join(lines, "\n") + "\n"
}

func tryMessage(dir, filename, lang string) string {
	return fmt.Sprintf(
		"* Try loading [%v (%v)](https://gmlewis.github.io/irmf-editor/?s=github.com/gmlewis/irmf-examples/blob/master/%v/%v) now in the IRMF editor!\n",
		filename, languageLabel[lang], dir, filename)
}

var fieldsToKeep = []string{
	"irmf",
	"language",
	"materials",
	"max",
	"min",
	"tslVersion",
	"units",
}

var newLicenseText = `----------------------------------------------------------------------

# License

Copyright 2020 Glenn M. Lewis. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
`
