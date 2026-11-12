'use strict';

// Inspirational quotes for children, each with English, Hindi and Telugu text.
// `original` holds the quote in the language it was first written in, when that is not English.
const QUOTES = [
  {
    text: {
      en: 'Dream is not that which you see while sleeping; it is something that does not let you sleep.',
      hi: 'सपने वो नहीं जो आप नींद में देखते हैं, सपने वो हैं जो आपको सोने नहीं देते।',
      te: 'నిద్రలో వచ్చేది కల కాదు, నిద్ర పోనివ్వకుండా చేసేదే నిజమైన కల.',
    },
    author: { en: 'Dr. A.P.J. Abdul Kalam', hi: 'डॉ. ए.पी.जे. अब्दुल कलाम', te: 'డా. ఏ.పి.జె. అబ్దుల్ కలాం' },
  },
  {
    text: {
      en: 'Arise, awake, and stop not till the goal is reached.',
      hi: 'उठो, जागो और तब तक मत रुको जब तक लक्ष्य प्राप्त न हो जाए।',
      te: 'లేవండి, మేల్కోండి, గమ్యం చేరేవరకు ఆగకండి.',
    },
    author: { en: 'Swami Vivekananda', hi: 'स्वामी विवेकानंद', te: 'స్వామి వివేకానంద' },
  },
  {
    text: {
      en: 'Live as if you were to die tomorrow. Learn as if you were to live forever.',
      hi: 'ऐसे जियो जैसे कल ही मरना हो, ऐसे सीखो जैसे हमेशा जीना हो।',
      te: 'రేపే చివరి రోజు అన్నట్లు జీవించు, ఎప్పటికీ జీవిస్తానన్నట్లు నేర్చుకో.',
    },
    author: { en: 'Mahatma Gandhi', hi: 'महात्मा गांधी', te: 'మహాత్మా గాంధీ' },
  },
  {
    original: 'దేశమంటే మట్టి కాదోయ్, దేశమంటే మనుషులోయ్',
    text: {
      en: 'A nation is not its soil; a nation is its people.',
      hi: 'देश मिट्टी नहीं है, देश उसके लोग हैं।',
      te: 'దేశమంటే మట్టి కాదోయ్, దేశమంటే మనుషులోయ్.',
    },
    author: { en: 'Gurajada Apparao', hi: 'गुरजाड़ा अप्पाराव', te: 'గురజాడ అప్పారావు' },
  },
  {
    original: 'विद्या ददाति विनयम्',
    text: {
      en: 'Knowledge gives humility.',
      hi: 'विद्या विनय देती है।',
      te: 'విద్య వినయాన్ని ఇస్తుంది.',
    },
    author: { en: 'Hitopadesha', hi: 'हितोपदेश', te: 'హితోపదేశం' },
  },
  {
    text: {
      en: 'Learning gives creativity, creativity leads to thinking, thinking provides knowledge, and knowledge makes you great.',
      hi: 'सीखने से रचनात्मकता आती है, रचनात्मकता से सोच, सोच से ज्ञान मिलता है और ज्ञान आपको महान बनाता है।',
      te: 'నేర్చుకోవడం సృజనాత్మకతను ఇస్తుంది, సృజనాత్మకత ఆలోచనకు దారితీస్తుంది, ఆలోచన జ్ఞానాన్ని ఇస్తుంది, జ్ఞానం మిమ్మల్ని గొప్పవారిని చేస్తుంది.',
    },
    author: { en: 'Dr. A.P.J. Abdul Kalam', hi: 'डॉ. ए.पी.जे. अब्दुल कलाम', te: 'డా. ఏ.పి.జె. అబ్దుల్ కలాం' },
  },
  {
    text: {
      en: 'Education is like the milk of a tigress; whoever drinks it will roar.',
      hi: 'शिक्षा शेरनी का दूध है, जो पिएगा वह दहाड़ेगा।',
      te: 'విద్య పులి పాల వంటిది, దానిని తాగినవారు గర్జిస్తారు.',
    },
    author: { en: 'Dr. B.R. Ambedkar', hi: 'डॉ. भीमराव आंबेडकर', te: 'డా. బి.ఆర్. అంబేద్కర్' },
  },
  {
    text: {
      en: 'Where the mind is without fear and the head is held high, where knowledge is free.',
      hi: 'जहाँ मन भय से मुक्त हो और सिर ऊँचा हो, जहाँ ज्ञान मुक्त हो।',
      te: 'ఎక్కడ మనసు భయం లేకుండా ఉంటుందో, ఎక్కడ తల ఎత్తుకుని నిలబడగలమో, ఎక్కడ జ్ఞానం స్వేచ్ఛగా ఉంటుందో.',
    },
    author: { en: 'Rabindranath Tagore', hi: 'रवींद्रनाथ टैगोर', te: 'రవీంద్రనాథ్ ఠాగూర్' },
  },
];

/** Quote text and author in the requested language (English fallback). */
function localize(q, lang) {
  return {
    text: q.text[lang] || q.text.en,
    author: q.author[lang] || q.author.en,
    original: q.original && q.original !== (q.text[lang] || '').replace(/[.।]$/, '') ? q.original : null,
  };
}

/** A different quote each day, the same for everyone on that day. */
function quoteOfTheDay(lang, date = new Date()) {
  const dayIndex = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
  return localize(QUOTES[dayIndex % QUOTES.length], lang);
}

function allQuotes(lang) {
  return QUOTES.map((q) => localize(q, lang));
}

module.exports = { quoteOfTheDay, allQuotes };
