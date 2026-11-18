package frontmatter

import "testing"

func TestSplit(t *testing.T) {
	tests := []struct {
		name     string
		content  string
		wantFM   string
		wantBody string
		wantOK   bool
	}{
		{
			name:     "basic block",
			content:  "---\nname: foo\n---\nbody text",
			wantFM:   "name: foo",
			wantBody: "body text",
			wantOK:   true,
		},
		{
			name:     "delimiter inside value is content",
			content:  "---\nname: foo\ndescription: a --- b\n---\nbody",
			wantFM:   "name: foo\ndescription: a --- b",
			wantBody: "body",
			wantOK:   true,
		},
		{
			name:     "delimiter inside body is content",
			content:  "---\nname: foo\n---\nbody with --- inside",
			wantFM:   "name: foo",
			wantBody: "body with --- inside",
			wantOK:   true,
		},
		{
			name:     "closing delimiter at EOF",
			content:  "---\nname: foo\n---",
			wantFM:   "name: foo",
			wantBody: "",
			wantOK:   true,
		},
		{
			name:     "trailing spaces after delimiters",
			content:  "--- \nname: foo\n--- \nbody",
			wantFM:   "name: foo",
			wantBody: "body",
			wantOK:   true,
		},
		{
			name:     "CRLF line endings",
			content:  "---\r\nname: foo\r\n---\r\nbody",
			wantFM:   "name: foo",
			wantBody: "body",
			wantOK:   true,
		},
		{
			name:     "leading BOM is stripped",
			content:  "\ufeff---\nname: foo\n---\nbody",
			wantFM:   "name: foo",
			wantBody: "body",
			wantOK:   true,
		},
		{
			name:     "no frontmatter returns whole body",
			content:  "just body text",
			wantFM:   "",
			wantBody: "just body text",
			wantOK:   false,
		},
		{
			name:     "unclosed block is not frontmatter",
			content:  "---\nname: foo\n",
			wantFM:   "",
			wantBody: "---\nname: foo",
			wantOK:   false,
		},
		{
			name:     "delimiter must start the content",
			content:  "lead\n---\nname: foo\n---\nbody",
			wantFM:   "",
			wantBody: "lead\n---\nname: foo\n---\nbody",
			wantOK:   false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fm, body, ok := Split(tt.content)
			if ok != tt.wantOK {
				t.Errorf("ok = %v, want %v", ok, tt.wantOK)
			}
			if fm != tt.wantFM {
				t.Errorf("frontmatter = %q, want %q", fm, tt.wantFM)
			}
			if body != tt.wantBody {
				t.Errorf("body = %q, want %q", body, tt.wantBody)
			}
		})
	}
}
