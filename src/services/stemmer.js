// Lightweight Porter stemmer for NLP term matching
// Matches the Go engine's snowball stemmer behavior for English

function stem(word) {
  if (word.length < 3) return word;
  word = word.toLowerCase();

  // Step 1a
  if (word.endsWith('sses')) word = word.slice(0, -2);
  else if (word.endsWith('ies')) word = word.slice(0, -2);
  else if (!word.endsWith('ss') && word.endsWith('s')) word = word.slice(0, -1);

  // Step 1b
  const step1b = (w) => {
    if (w.endsWith('eed')) {
      const stem = w.slice(0, -3);
      if (measureGt0(stem)) return stem + 'ee';
      return w;
    }
    for (const suffix of ['ed', 'ing']) {
      if (w.endsWith(suffix)) {
        const stem = w.slice(0, -suffix.length);
        if (containsVowel(stem)) {
          if (stem.endsWith('at') || stem.endsWith('bl') || stem.endsWith('iz')) return stem + 'e';
          if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2] &&
            !'lsz'.includes(stem[stem.length - 1])) return stem.slice(0, -1);
          if (measure(stem) === 1 && cvc(stem)) return stem + 'e';
          return stem;
        }
      }
    }
    return w;
  };
  word = step1b(word);

  // Step 1c
  if (word.endsWith('y') && containsVowel(word.slice(0, -1))) {
    word = word.slice(0, -1) + 'i';
  }

  // Step 2
  const step2Map = {
    ational: 'ate', tional: 'tion', enci: 'ence', anci: 'ance',
    izer: 'ize', abli: 'able', alli: 'al', entli: 'ent',
    eli: 'e', ousli: 'ous', ization: 'ize', ation: 'ate',
    ator: 'ate', alism: 'al', iveness: 'ive', fulness: 'ful',
    ousness: 'ous', aliti: 'al', iviti: 'ive', biliti: 'ble',
  };
  for (const [suffix, replacement] of Object.entries(step2Map)) {
    if (word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      if (measureGt0(stem)) { word = stem + replacement; break; }
    }
  }

  // Step 3
  const step3Map = {
    icate: 'ic', ative: '', alize: 'al', iciti: 'ic', ical: 'ic', ful: '', ness: '',
  };
  for (const [suffix, replacement] of Object.entries(step3Map)) {
    if (word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      if (measureGt0(stem)) { word = stem + replacement; break; }
    }
  }

  // Step 4
  const step4Suffixes = [
    'al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement',
    'ment', 'ent', 'ion', 'ou', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize',
  ];
  for (const suffix of step4Suffixes) {
    if (word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      if (measure(stem) > 1) {
        if (suffix === 'ion' && stem.length > 0 && (stem.endsWith('s') || stem.endsWith('t'))) {
          word = stem;
        } else if (suffix !== 'ion') {
          word = stem;
        }
        break;
      }
    }
  }

  // Step 5a
  if (word.endsWith('e')) {
    const stem = word.slice(0, -1);
    if (measure(stem) > 1 || (measure(stem) === 1 && !cvc(stem))) word = stem;
  }

  // Step 5b
  if (measure(word) > 1 && word.length >= 2 &&
    word[word.length - 1] === word[word.length - 2] && word.endsWith('l')) {
    word = word.slice(0, -1);
  }

  return word;
}

function isVowel(ch) { return 'aeiou'.includes(ch); }

function containsVowel(str) {
  for (const ch of str) { if (isVowel(ch)) return true; }
  return false;
}

function measure(str) {
  let m = 0;
  let i = 0;
  while (i < str.length && isVowel(str[i])) i++;
  while (i < str.length) {
    while (i < str.length && !isVowel(str[i])) i++;
    if (i >= str.length) break;
    m++;
    while (i < str.length && isVowel(str[i])) i++;
  }
  return m;
}

function measureGt0(str) { return measure(str) > 0; }

function cvc(str) {
  if (str.length < 3) return false;
  const c1 = str[str.length - 1];
  const v = str[str.length - 2];
  const c2 = str[str.length - 3];
  return !isVowel(c1) && isVowel(v) && !isVowel(c2) && !'wxy'.includes(c1);
}

function stemPhrase(phrase) {
  return phrase.toLowerCase().split(/\s+/).filter(Boolean).map(stem).join(' ');
}

function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
}

function buildStemmedNGrams(text, maxN) {
  const words = tokenize(text);
  const stemmed = words.map(stem);
  const grams = {};

  for (let n = 1; n <= Math.min(maxN, 3); n++) {
    for (let i = 0; i <= stemmed.length - n; i++) {
      const gram = stemmed.slice(i, i + n).join(' ');
      grams[gram] = (grams[gram] || 0) + 1;
    }
  }
  return grams;
}

module.exports = { stem, stemPhrase, tokenize, buildStemmedNGrams };
