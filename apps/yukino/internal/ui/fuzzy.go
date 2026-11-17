package ui

import (
	"math"
	"sort"
	"strings"
	"unicode"
)

// Port of the Fuse.js v7.5.0 bitap search used by the reference selectors
// (threshold, ignoreLocation and weighted keys).

const fuseMaxBits = 32

// numberEpsilon mirrors Number.EPSILON, used for exact (score 0) matches.
const numberEpsilon = 2.220446049250313e-16

type fuseKey[T any] struct {
	weight float64
	// get reports ok=false when the item lacks the field, matching the
	// reference behavior of skipping undefined values.
	get func(T) (string, bool)
}

type fuseIndexEntry struct {
	text    []rune
	norm    float64
	present bool
}

type fuseMatch struct {
	score  float64
	weight float64
	norm   float64
}

// computeScoreSingle mirrors fuse.js computeScoreSingle.
func computeScoreSingle(matches []fuseMatch) float64 {
	totalScore := 1.0
	for _, match := range matches {
		score := match.score
		if score == 0 && match.weight > 0 {
			score = numberEpsilon
		}
		totalScore *= math.Pow(score, match.weight*match.norm)
	}
	return totalScore
}

// fieldNorm mirrors fuse.js fieldNorm (weight 1, mantissa 3).
func fieldNorm(value string, weight float64) float64 {
	numTokens := 0
	inWord := false
	for _, c := range value {
		if isWordSeparatorRune(c) {
			inWord = false
			continue
		}
		if !inWord {
			numTokens++
			inWord = true
		}
	}
	if numTokens == 0 {
		numTokens = 1
	}
	const m = 1000.0
	return math.Round(m/math.Pow(float64(numTokens), 0.5*weight)) / m
}

func isWordSeparatorRune(c rune) bool {
	return (c >= 9 && c <= 13) || c == 32 || c == 160
}

// Fuse mirrors a Fuse.js instance over a fixed item list.
type Fuse[T any] struct {
	items          []T
	keys           []fuseKey[T]
	entries        [][]fuseIndexEntry
	threshold      float64
	ignoreLocation bool
}

// NewFuse builds the index; key weights are normalized by their total, as in
// the reference KeyStore.
func NewFuse[T any](items []T, keys []fuseKey[T], threshold float64, ignoreLocation bool) *Fuse[T] {
	totalWeight := 0.0
	normalized := make([]fuseKey[T], len(keys))
	for i, key := range keys {
		weight := key.weight
		if weight == 0 {
			weight = 1
		}
		normalized[i] = fuseKey[T]{weight: weight, get: key.get}
		totalWeight += weight
	}
	for i := range normalized {
		normalized[i].weight /= totalWeight
	}

	f := &Fuse[T]{
		items:          items,
		keys:           normalized,
		threshold:      threshold,
		ignoreLocation: ignoreLocation,
	}
	f.entries = make([][]fuseIndexEntry, len(items))
	for i, item := range items {
		row := make([]fuseIndexEntry, len(normalized))
		for j, key := range normalized {
			text, ok := key.get(item)
			if !ok {
				continue
			}
			row[j] = fuseIndexEntry{text: []rune(text), norm: fieldNorm(text, 1), present: true}
		}
		f.entries[i] = row
	}
	return f
}

// Search returns the matching items ordered by score ascending (ties keep
// their original order), mirroring fuse.js results.
func (f *Fuse[T]) Search(query string) []T {
	searcher := newBitapSearch(query, f.threshold, f.ignoreLocation)
	type scored struct {
		item  T
		score float64
		idx   int
	}
	var results []scored
	for i, item := range f.items {
		var matches []fuseMatch
		for j, key := range f.keys {
			entry := f.entries[i][j]
			if !entry.present {
				continue
			}
			isMatch, score := searcher.searchIn(entry.text)
			if isMatch {
				matches = append(matches, fuseMatch{score: score, weight: key.weight, norm: entry.norm})
			}
		}
		if len(matches) > 0 {
			results = append(results, scored{item: item, score: computeScoreSingle(matches), idx: i})
		}
	}
	sort.SliceStable(results, func(a, b int) bool {
		if results[a].score == results[b].score {
			return results[a].idx < results[b].idx
		}
		return results[a].score < results[b].score
	})
	out := make([]T, len(results))
	for i, result := range results {
		out[i] = result.item
	}
	return out
}

type bitapChunk struct {
	pattern    []rune
	alphabet   map[rune]uint32
	startIndex int
}

type bitapSearch struct {
	pattern        []rune
	chunks         []bitapChunk
	threshold      float64
	ignoreLocation bool
}

func newBitapSearch(pattern string, threshold float64, ignoreLocation bool) *bitapSearch {
	lowered := []rune(strings.ToLower(pattern))
	b := &bitapSearch{pattern: lowered, threshold: threshold, ignoreLocation: ignoreLocation}
	if len(lowered) == 0 {
		return b
	}
	addChunk := func(p []rune, startIndex int) {
		alphabet := make(map[rune]uint32, len(p))
		for i, c := range p {
			alphabet[c] |= 1 << uint(len(p)-i-1)
		}
		b.chunks = append(b.chunks, bitapChunk{pattern: p, alphabet: alphabet, startIndex: startIndex})
	}
	if len(lowered) > fuseMaxBits {
		i := 0
		remainder := len(lowered) % fuseMaxBits
		end := len(lowered) - remainder
		for i < end {
			addChunk(lowered[i:i+fuseMaxBits], i)
			i += fuseMaxBits
		}
		if remainder != 0 {
			startIndex := len(lowered) - fuseMaxBits
			addChunk(lowered[startIndex:], startIndex)
		}
	} else {
		addChunk(lowered, 0)
	}
	return b
}

func (b *bitapSearch) searchIn(text []rune) (bool, float64) {
	if len(b.pattern) == 0 {
		return false, 1
	}
	lowered := make([]rune, len(text))
	for i, c := range text {
		lowered[i] = unicode.ToLower(c)
	}
	if runesEqual(b.pattern, lowered) {
		if len(lowered) < 1 {
			return false, 1
		}
		return true, 0
	}
	totalScore := 0.0
	hasMatches := false
	for _, chunk := range b.chunks {
		isMatch, score := bitapSearchText(lowered, chunk, b.threshold, b.ignoreLocation)
		if isMatch {
			hasMatches = true
		}
		totalScore += score
	}
	if hasMatches {
		return true, totalScore / float64(len(b.chunks))
	}
	return false, 1
}

// bitapSearchText ports fuse.js search() from src/search/bitap/search.ts with
// location 0, distance 100, findAllMatches/includeMatches off and
// minMatchCharLength 1.
func bitapSearchText(text []rune, chunk bitapChunk, threshold float64, ignoreLocation bool) (bool, float64) {
	pattern := chunk.pattern
	patternLen := len(pattern)
	textLen := len(text)
	const distance = 100
	expectedLocation := chunk.startIndex
	if expectedLocation < 0 {
		expectedLocation = 0
	}
	if expectedLocation > textLen {
		expectedLocation = textLen
	}
	currentThreshold := threshold
	bestLocation := expectedLocation
	calcScore := func(errors, currentLocation int) float64 {
		accuracy := float64(errors) / float64(patternLen)
		if ignoreLocation {
			return accuracy
		}
		proximity := expectedLocation - currentLocation
		if proximity < 0 {
			proximity = -proximity
		}
		if distance == 0 {
			if proximity != 0 {
				return 1
			}
			return accuracy
		}
		return accuracy + float64(proximity)/float64(distance)
	}

	for idx := runesIndexOf(text, pattern, bestLocation); idx > -1; idx = runesIndexOf(text, pattern, bestLocation) {
		if score := calcScore(0, idx); score < currentThreshold {
			currentThreshold = score
		}
		bestLocation = idx + patternLen
	}

	bestLocation = -1
	var lastBitArr []uint32
	finalScore := 1.0
	binMax := patternLen + textLen
	mask := uint32(1) << uint(patternLen-1)
	for i := 0; i < patternLen; i++ {
		binMin := 0
		binMid := binMax
		for binMin < binMid {
			if calcScore(i, expectedLocation+binMid) <= currentThreshold {
				binMin = binMid
			} else {
				binMax = binMid
			}
			binMid = (binMax-binMin)/2 + binMin
		}
		binMax = binMid
		start := expectedLocation - binMid + 1
		if start < 1 {
			start = 1
		}
		finish := expectedLocation + binMid
		if finish > textLen {
			finish = textLen
		}
		finish += patternLen
		bitArr := make([]uint32, finish+2)
		bitArr[finish+1] = (uint32(1) << uint(i)) - 1
		for j := finish; j >= start; j-- {
			currentLocation := j - 1
			var charMatch uint32
			if currentLocation < textLen {
				charMatch = chunk.alphabet[text[currentLocation]]
			}
			bitArr[j] = (bitArr[j+1]<<1 | 1) & charMatch
			if i > 0 {
				var next, cur uint32
				if j+1 < len(lastBitArr) {
					next = lastBitArr[j+1]
				}
				if j < len(lastBitArr) {
					cur = lastBitArr[j]
				}
				bitArr[j] |= (next|cur)<<1 | 1 | next
			}
			if bitArr[j]&mask != 0 {
				finalScore = calcScore(i, currentLocation)
				if finalScore <= currentThreshold {
					currentThreshold = finalScore
					bestLocation = currentLocation
					if bestLocation <= expectedLocation {
						break
					}
					start = 2*expectedLocation - bestLocation
					if start < 1 {
						start = 1
					}
				}
			}
		}
		if calcScore(i+1, expectedLocation) > currentThreshold {
			break
		}
		lastBitArr = bitArr
	}

	return bestLocation >= 0, math.Max(0.001, finalScore)
}

func runesEqual(a, b []rune) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func runesIndexOf(text, pattern []rune, from int) int {
	if from < 0 {
		from = 0
	}
	if len(pattern) == 0 {
		if from <= len(text) {
			return from
		}
		return -1
	}
	for i := from; i+len(pattern) <= len(text); i++ {
		match := true
		for j, c := range pattern {
			if text[i+j] != c {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}
