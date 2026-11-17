package operations

import (
	"reflect"
	"testing"
)

func TestNodeStringEncoding(t *testing.T) {
	if UTF16Length("中😀") != 3 || UTF16Prefix("a😀b", 2) != "a�" {
		t.Fatal("UTF-16 length/slice mismatch")
	}
	if TrimJS("\ufeff x \ufeff") != "x" || TrimJS("\u0085x\u0085") != "\u0085x\u0085" {
		t.Fatal("ECMAScript whitespace mismatch")
	}
	for _, test := range []struct {
		raw  []byte
		want string
	}{
		{[]byte{0xff, 0xff}, "��"}, {[]byte{0xe2, 0x82}, "�"}, {[]byte{0xe2, 0x82, 0xff}, "��"}, {[]byte{0xed, 0xa0, 0x80}, "���"}, {[]byte{0xf0, 0x9f, 0x98, 0x80}, "😀"},
	} {
		if got := DecodeUTF8(test.raw); got != test.want {
			t.Errorf("UTF8 %x: got %q want %q", test.raw, got, test.want)
		}
	}
	if got := DecodeBase64(" _-8 !\n="); !reflect.DeepEqual(got, []byte{255, 239}) {
		t.Fatalf("base64: %x", got)
	}
}
