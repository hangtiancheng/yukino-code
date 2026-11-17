package ui

import (
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/charmbracelet/x/term"
	"github.com/muesli/cancelreader"
)

type terminalInputFilter struct {
	pending string
	pasting bool
}

func partialSuffixLength(text, marker string) int {
	for n := min(len(text), len(marker)-1); n > 0; n-- {
		if strings.HasSuffix(text, marker[:n]) {
			return n
		}
	}
	return 0
}

func (f *terminalInputFilter) feed(chunk string) (string, []string, bool) {
	f.pending += chunk
	var output strings.Builder
	var reports []string
	for f.pending != "" {
		if !f.pasting && strings.HasPrefix(f.pending, oscBackground) {
			body := f.pending[len(oscBackground):]
			end := strings.IndexByte(body, '\x07')
			st := strings.Index(body, "\x1b\\")
			if st >= 0 && (end < 0 || st < end) {
				end = st
			}
			if end < 0 {
				break
			}
			end += len(oscBackground)
			length := end + 1
			if f.pending[end] == '\x1b' {
				length++
			}
			reports = append(reports, f.pending[:length])
			f.pending = f.pending[length:]
			continue
		}
		if !f.pasting && strings.HasPrefix(f.pending, colorScheme) {
			end := strings.IndexByte(f.pending[len(colorScheme):], 'n')
			if end < 0 {
				break
			}
			length := len(colorScheme) + end + 1
			reports = append(reports, f.pending[:length])
			f.pending = f.pending[length:]
			continue
		}
		marker := pasteStart
		if f.pasting {
			marker = pasteEnd
		}
		if strings.HasPrefix(f.pending, marker) {
			f.pasting = !f.pasting
			output.WriteString(marker)
			f.pending = f.pending[len(marker):]
			continue
		}
		if f.pasting {
			end := strings.Index(f.pending, pasteEnd)
			if end < 0 {
				end = len(f.pending) - partialSuffixLength(f.pending, pasteEnd)
				output.WriteString(f.pending[:end])
				f.pending = f.pending[end:]
				break
			}
			output.WriteString(f.pending[:end])
			f.pending = f.pending[end:]
			continue
		}
		esc := strings.IndexByte(f.pending, '\x1b')
		if esc < 0 {
			output.WriteString(f.pending)
			f.pending = ""
			break
		}
		if esc > 0 {
			output.WriteString(f.pending[:esc])
			f.pending = f.pending[esc:]
			continue
		}
		if strings.HasPrefix(oscBackground, f.pending) || strings.HasPrefix(colorScheme, f.pending) || strings.HasPrefix(pasteStart, f.pending) {
			break
		}
		output.WriteByte(f.pending[0])
		f.pending = f.pending[1:]
	}
	return output.String(), reports, f.pending == "\x1b" && !f.pasting
}

type TerminalInput struct {
	Stdin    *os.File
	source   *os.File
	writer   *os.File
	reader   cancelreader.CancelReader
	rawState *term.State
	isTTY    bool
	reports  chan string
	stop     chan struct{}
	readDone chan struct{}
	once     sync.Once
}

func NewTerminalInput(source *os.File) (*TerminalInput, error) {
	r, w, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	reader, err := cancelreader.NewReader(source)
	if err != nil {
		r.Close()
		w.Close()
		return nil, err
	}
	input := &TerminalInput{Stdin: r, source: source, writer: w, reader: reader, isTTY: term.IsTerminal(source.Fd()), reports: make(chan string, 16), stop: make(chan struct{})}
	if input.isTTY {
		input.rawState, err = term.MakeRaw(source.Fd())
		if err != nil {
			input.Close()
			return nil, err
		}
	}
	input.readDone = make(chan struct{})
	go input.pump()
	return input, nil
}

func (input *TerminalInput) pump() {
	type readResult struct {
		data string
		err  error
	}
	chunks := make(chan readResult)
	go func() {
		defer close(input.readDone)
		buf := make([]byte, 64*1024)
		for {
			n, err := input.reader.Read(buf)
			select {
			case chunks <- readResult{string(buf[:n]), err}:
			case <-input.stop:
				return
			}
			if err != nil {
				return
			}
		}
	}()
	defer input.writer.Close()
	var filter terminalInputFilter
	var escape <-chan time.Time
	var timer *time.Timer
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()
	for {
		select {
		case chunk := <-chunks:
			if timer != nil {
				timer.Stop()
			}
			escape = nil
			output, reports, literalEscape := filter.feed(chunk.data)
			for _, report := range reports {
				select {
				case input.reports <- report:
				default:
				}
			}
			if output != "" {
				if _, err := io.WriteString(input.writer, output); err != nil {
					return
				}
			}
			if chunk.err != nil {
				io.WriteString(input.writer, filter.pending)
				return
			}
			if literalEscape {
				timer = time.NewTimer(25 * time.Millisecond)
				escape = timer.C
			}
		case <-escape:
			if _, err := io.WriteString(input.writer, filter.pending); err != nil {
				return
			}
			filter.pending, escape = "", nil
		case <-input.stop:
			return
		}
	}
}

func (input *TerminalInput) Close() error {
	var err error
	input.once.Do(func() {
		close(input.stop)
		canceled := input.reader.Cancel()
		input.Stdin.Close()
		input.writer.Close()
		if input.readDone == nil {
			input.reader.Close()
		} else if canceled {
			<-input.readDone
			input.reader.Close()
		} else {
			go func() { <-input.readDone; input.reader.Close() }()
		}
		if input.rawState != nil {
			err = term.Restore(input.source.Fd(), input.rawState)
		}
	})
	return err
}
