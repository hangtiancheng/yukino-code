// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package utils

import "math/rand"

// spinnerVerbs are the in-progress activity words shown while the agent
// works. Copied verbatim from src/utils/verbs.ts.
var spinnerVerbs = []string{
	"Accomplishing",
	"Architecting",
	"Baking",
	"Barking",
	"Woofing",
	"Howling",
	"Be-bopping'",
	"Befuddling",
	"Boogieing",
	"Boondoggling",
	"Bootstrapping",
	"Brewing",
	"Calculating",
	"Canoodling",
	"Caramelizing",
	"Cascading",
	"Cerebrating",
	"Choreographing",
	"Churning",
	"Coalescing",
	"Cogitating",
	"Combobulating",
	"Composing",
	"Computing",
	"Concocting",
	"Considering",
	"Contemplating",
	"Cooking",
	"Crafting",
	"Creating",
	"Crunching",
	"Crystallizing",
	"Cultivating",
	"Deciphering",
	"Deliberating",
	"Dilly-dallying",
	"Discombobulating",
	"Doodling",
	"Elucidating",
	"Enchanting",
	"Envisioning",
	"Fermenting",
	"Finagling",
	"Flambéing",
	"Flummoxing",
	"Forging",
	"Frolicking",
	"Gallivanting",
	"Garnishing",
	"Generating",
	"Germinating",
	"Grooving",
	"Harmonizing",
	"Hatching",
	"Honking",
	"Ideating",
	"Imagining",
	"Improvising",
	"Incubating",
	"Inferring",
	"Infusing",
	"Kneading",
	"Lollygagging",
	"Manifesting",
	"Marinating",
	"Meandering",
	"Metamorphosing",
	"Mewing",
	"Moonwalking",
	"Moseying",
	"Mulling",
	"Musing",
	"Noodling",
	"Orbiting",
	"Orchestrating",
	"Percolating",
	"Philosophizing",
	"Pondering",
	"Pontificating",
	"Pouncing",
	"Purring",
	"Puzzling",
	"Razzle-dazzling",
	"Ruminating",
	"Scampering",
	"Simmering",
	"Sketching",
	"Spelunking",
	"Spinning",
	"Sprouting",
	"Synthesizing",
	"Thinking",
	"Tinkering",
	"Transfiguring",
	"Transmuting",
	"Undulating",
	"Unfurling",
	"Unravelling",
	"Vibing",
	"Wandering",
	"Whisking",
	"Working",
	"Wrangling",
	"Zigzagging",
}

// RandomVerb returns a random in-progress activity word for spinner
// displays. Port of randomVerb.
func RandomVerb() string {
	return spinnerVerbs[rand.Intn(len(spinnerVerbs))]
}

// completionVerbs are the past-tense words shown when work finishes.
// Copied verbatim from src/utils/verbs.ts.
var completionVerbs = []string{
	"Accomplished",
	"Baked",
	"Brewed",
	"Cooked",
	"Crafted",
	"Crunched",
	"Forged",
	"Hatched",
	"Pondered",
	"Synthesized",
	"Tinkered",
	"Worked",
	"Wrangled",
	"Computed",
	"Created",
	"Composed",
	"Conjured",
	"Concocted",
	"Cultivated",
	"Deciphered",
}

// RandomCompletionVerb returns a random past-tense completion word.
// Port of randomCompletionVerb.
func RandomCompletionVerb() string {
	return completionVerbs[rand.Intn(len(completionVerbs))]
}
