import { UserFacingError } from './errors.js';

/**
 * Prompt guard (DESIGN section 10): one file, keyword lists, tested. It runs BEFORE any provider is called and
 * before any quota is reserved. It is deliberately conservative and simple; it is a first filter, the providers'
 * own safety systems still apply (their refusals become plain-language messages and are never retried elsewhere).
 *
 * Refused:
 *  1. depicting real, identifiable people (named public figures, "deepfake", "face swap", "looks like <celebrity>")
 *  2. minors in sensitive contexts (a minor term and an adult, violent, substance or gambling term in the same sentence)
 *  3. third-party logos, brands and characters (brand and character names)
 *
 * Allowed: editing the user's own photo. Faces and people in the photo are never a reason to refuse an edit; only
 * what the instruction asks for is checked, so "make me look professional" passes while "put Messi next to me" does not.
 *
 * Matching is accent-insensitive and case-insensitive, on whole words, in English, Spanish and Portuguese.
 */

export type SafetyCategory = 'real_person' | 'minor' | 'brand';
export type SafetyTask = 'generate' | 'edit';

export interface SafetyFinding {
  category: SafetyCategory;
  /** The text that matched (taken from the request itself). */
  term: string;
}

/** Lower-case, strip accents and apostrophes, collapse whitespace. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/['’`´]/g, '')
    .replace(/[^a-z0-9&+.\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One regex for a list of names/phrases, whole words only; spaces match spaces or hyphens. */
function wordList(terms: readonly string[]): RegExp {
  const parts = terms.map((t) => escapeRe(normalize(t)).replace(/\\?[ -]/g, '[ -]'));
  return new RegExp(`(?<![a-z0-9])(?:${parts.join('|')})(?![a-z0-9])`);
}

// ---- 1. Real people ---------------------------------------------------------------------------------------

/** Widely recognised public figures. Full names unless the single name is unambiguous. */
const REAL_PEOPLE: readonly string[] = [
  // politics and public office
  'donald trump', 'joe biden', 'biden', 'barack obama', 'obama', 'kamala harris', 'hillary clinton', 'bill clinton', 'vladimir putin', 'putin',
  'xi jinping', 'emmanuel macron', 'angela merkel', 'boris johnson', 'rishi sunak', 'keir starmer', 'narendra modi', 'volodymyr zelensky', 'zelensky',
  'zelenskyy', 'justin trudeau', 'javier milei', 'milei', 'pedro sanchez', 'nayib bukele', 'bukele', 'lula da silva', 'bolsonaro', 'nicolas maduro',
  'hugo chavez', 'fidel castro', 'che guevara', 'cristina kirchner', 'claudia sheinbaum', 'andres manuel lopez obrador', 'amlo', 'gustavo petro',
  'queen elizabeth', 'king charles', 'prince harry', 'meghan markle', 'prince william', 'kate middleton', 'pope francis', 'pope leo', 'dalai lama',
  'benjamin netanyahu', 'kim jong un', 'recep erdogan', 'adolf hitler', 'hitler', 'stalin', 'mussolini',
  // technology and business
  'elon musk', 'jeff bezos', 'mark zuckerberg', 'bill gates', 'steve jobs', 'tim cook', 'sam altman', 'sundar pichai', 'satya nadella', 'jensen huang',
  'warren buffett', 'larry page', 'sergey brin', 'jack ma', 'richard branson', 'oprah winfrey', 'martha stewart', 'gary vaynerchuk',
  // sport
  'lionel messi', 'messi', 'cristiano ronaldo', 'ronaldo', 'neymar', 'kylian mbappe', 'mbappe', 'erling haaland', 'haaland', 'diego maradona', 'maradona',
  'lebron james', 'michael jordan', 'kobe bryant', 'stephen curry', 'serena williams', 'roger federer', 'rafael nadal', 'novak djokovic',
  'tiger woods', 'usain bolt', 'simone biles', 'lewis hamilton', 'max verstappen', 'conor mcgregor', 'tom brady', 'david beckham', 'zinedine zidane',
  // music, film, television and internet
  'taylor swift', 'beyonce', 'rihanna', 'shakira', 'bad bunny', 'kanye west', 'justin bieber', 'ariana grande', 'billie eilish',
  'lady gaga', 'katy perry', 'selena gomez', 'dua lipa', 'ed sheeran', 'bruno mars', 'the weeknd', 'karol g', 'maluma', 'j balvin', 'anuel aa',
  'michael jackson', 'elvis presley', 'freddie mercury', 'john lennon', 'bob marley', 'frank sinatra', 'marilyn monroe', 'audrey hepburn',
  'brad pitt', 'angelina jolie', 'leonardo dicaprio', 'tom cruise', 'tom hanks', 'scarlett johansson', 'keanu reeves', 'dwayne johnson', 'margot robbie',
  'zendaya', 'emma watson', 'emma stone', 'will smith', 'morgan freeman', 'robert downey', 'chris hemsworth', 'chris evans', 'ryan reynolds',
  'jennifer lopez', 'jennifer aniston', 'jennifer lawrence', 'anne hathaway', 'natalie portman', 'sandra bullock', 'johnny depp', 'harrison ford',
  'arnold schwarzenegger', 'sylvester stallone', 'bruce lee', 'jackie chan', 'tom holland', 'timothee chalamet', 'pedro pascal', 'penelope cruz',
  'salma hayek', 'sofia vergara', 'ana de armas', 'kim kardashian', 'kylie jenner', 'kendall jenner', 'paris hilton', 'mrbeast', 'mr beast',
  'pewdiepie', 'ibai llanos', 'auronplay', 'cardi b', 'nicki minaj', 'post malone', 'travis scott', 'snoop dogg', 'eminem',
  // authors, scientists, historical icons
  'albert einstein', 'stephen hawking', 'isaac newton', 'nikola tesla', 'mahatma gandhi', 'nelson mandela', 'martin luther king', 'mother teresa',
  'princess diana', 'jfk', 'abraham lincoln', 'napoleon bonaparte', 'muhammad ali',
];

const REAL_PEOPLE_RE = wordList(REAL_PEOPLE);

/** Phrases that ask for a specific real person without naming one. */
const REAL_PERSON_PHRASES = wordList([
  'deepfake', 'deep fake', 'face swap', 'faceswap', 'swap the face', 'lookalike', 'look alike of', 'doppelganger of', 'likeness of',
  'impersonate', 'impersonating', 'resembling a celebrity', 'looks like a celebrity',
]);

/** Generic "famous person" requests; for generation only (an edit of your own photo may say "like a model"). */
const FAMOUS_GENERIC = wordList([
  'celebrity', 'celebrities', 'celebridad', 'celebridades', 'celebridade', 'famous person', 'famous actor', 'famous actress', 'famous singer',
  'famous politician', 'famous athlete', 'persona famosa', 'actor famoso', 'actriz famosa', 'cantante famoso', 'politico famoso', 'pessoa famosa',
]);

// ---- 2. Minors in sensitive contexts ----------------------------------------------------------------------

const MINOR_TERMS = wordList([
  'child', 'children', 'kid', 'kids', 'boy', 'boys', 'girl', 'girls', 'teen', 'teens', 'teenager', 'teenagers', 'minor', 'minors', 'underage',
  'under age', 'toddler', 'toddlers', 'infant', 'baby', 'babies', 'schoolgirl', 'schoolboy', 'preteen', 'tween', 'juvenile', 'little girl',
  'little boy', 'young boy', 'young girl', 'nino', 'nina', 'ninos', 'ninas', 'menor', 'menores', 'adolescente', 'adolescentes', 'bebe', 'bebes',
  'chiquillo', 'chiquilla', 'crianca', 'criancas', 'menino', 'menina', 'meninos', 'meninas',
]);

const SENSITIVE_TERMS = wordList([
  // adult / sexual
  'nude', 'nudes', 'naked', 'nsfw', 'sexy', 'sexual', 'sex', 'erotic', 'lingerie', 'underwear', 'bikini', 'topless', 'seductive', 'provocative',
  'fetish', 'porn', 'porno', 'cleavage', 'desnudo', 'desnuda', 'desnudos', 'erotico', 'erotica', 'lenceria', 'ropa interior', 'sensual', 'nua', 'sexualizado',
  // violence and weapons
  'gore', 'blood', 'bloody', 'corpse', 'dead body', 'wound', 'weapon', 'weapons', 'gun', 'guns', 'rifle', 'pistol', 'firearm', 'violence', 'violent',
  'sangre', 'sangrienta', 'sangriento', 'arma', 'armas', 'pistola', 'cadaver', 'violencia', 'sangue', 'violento',
  // substances and gambling
  'cigarette', 'cigarettes', 'smoking', 'vape', 'vaping', 'alcohol', 'beer', 'wine', 'whiskey', 'vodka', 'drunk', 'drugs', 'cocaine', 'marijuana',
  'cannabis', 'gambling', 'casino', 'betting', 'cigarro', 'cigarrillo', 'cerveza', 'vino', 'borracho', 'droga', 'drogas', 'cocaina', 'marihuana',
  'apuestas', 'cerveja', 'bebida alcoolica', 'aposta',
]);

/** Always refused, whatever the sentence looks like. */
const ABSOLUTE_MINOR_TERMS = wordList(['loli', 'lolicon', 'shota', 'shotacon', 'csam', 'child porn', 'kiddie porn', 'pedo', 'pedophile', 'pedofilo']);

// ---- 3. Third-party brands, logos and characters ------------------------------------------------------------

const BRANDS: readonly string[] = [
  // sportswear, fashion, luxury
  'nike', 'adidas', 'reebok', 'under armour', 'new balance', 'lululemon', 'the north face', 'vans old skool', 'gucci', 'louis vuitton',
  'chanel', 'prada', 'hermes', 'rolex', 'cartier', 'tiffany', 'versace', 'balenciaga', 'burberry', 'ray-ban', 'rayban', 'zara', 'h&m', 'shein', 'uniqlo',
  // food, drink, retail
  'coca-cola', 'coca cola', 'cocacola', 'pepsi', 'fanta', 'sprite logo', 'red bull', 'monster energy', 'starbucks', 'mcdonalds', 'burger king', 'kfc',
  'taco bell', 'dominos', 'pizza hut', 'heineken', 'budweiser', 'jack daniels', 'nestle', 'nutella', 'oreo', 'cheetos', 'doritos', 'pringles',
  'walmart', 'costco', 'ikea', 'amazon prime', 'mercado libre', 'mercadolibre',
  // technology and media platforms
  'google', 'microsoft', 'iphone', 'ipad', 'macbook', 'apple logo', 'apple inc', 'samsung', 'sony', 'playstation', 'xbox', 'nintendo', 'netflix',
  'spotify', 'youtube', 'tiktok', 'instagram', 'facebook', 'whatsapp', 'twitter', 'linkedin', 'snapchat', 'paypal', 'mastercard', 'openai', 'chatgpt',
  // cars and vehicles
  'tesla', 'ferrari', 'lamborghini', 'porsche', 'bmw', 'mercedes-benz', 'mercedes benz', 'toyota', 'land rover', 'harley-davidson', 'harley davidson',
  // characters, franchises and studios
  'disney', 'pixar', 'marvel', 'dc comics', 'warner bros', 'mickey mouse', 'minnie mouse', 'donald duck', 'winnie the pooh', 'mario bros',
  'super mario', 'luigi', 'pikachu', 'pokemon', 'hello kitty', 'barbie', 'batman', 'superman', 'spider-man', 'spiderman', 'iron man', 'ironman',
  'captain america', 'avengers', 'wonder woman', 'the hulk', 'darth vader', 'star wars', 'yoda', 'baby yoda', 'harry potter', 'hogwarts',
  'lord of the rings', 'game of thrones', 'frozen elsa', 'elsa from frozen', 'the simpsons', 'bart simpson', 'homer simpson', 'spongebob', 'peppa pig',
  'paw patrol', 'sonic the hedgehog', 'donkey kong', 'zelda', 'minecraft', 'fortnite', 'angry birds', 'shrek', 'minions', 'goku', 'naruto',
  'dragon ball', 'bugs bunny', 'tom and jerry', 'scooby-doo', 'scooby doo', 'bluey', 'cocomelon', 'lego', 'optimus prime',
  'jurassic park', 'lightning mcqueen', 'toy story', 'woody and buzz', 'buzz lightyear', 'hello kitty', 'snoopy', 'garfield', 'tweety',
];

const BRANDS_RE = wordList(BRANDS);

// ---- Public API ---------------------------------------------------------------------------------------------

/** First problem found in the texts the user supplied (prompt, style, text to draw). Null when it is fine. */
export function findSafetyIssue(task: SafetyTask, texts: readonly (string | undefined)[]): SafetyFinding | null {
  const raw = texts.filter((t): t is string => typeof t === 'string' && t.trim() !== '');

  for (const text of raw.map(normalize)) {
    const absolute = ABSOLUTE_MINOR_TERMS.exec(text);
    if (absolute) return { category: 'minor', term: absolute[0] };
  }

  for (const original of raw) {
    const text = normalize(original);

    // 1. Real people. Faces in the user's own photo are fine for edits; naming a public figure never is.
    const person = REAL_PEOPLE_RE.exec(text) ?? REAL_PERSON_PHRASES.exec(text) ?? (task === 'generate' ? FAMOUS_GENERIC.exec(text) : null);
    if (person) return { category: 'real_person', term: person[0] };

    // 2. Minors next to something adult, violent, or regulated, in the same sentence.
    for (const sentence of original.split(/[.!?;\n]+/).map(normalize)) {
      const minor = MINOR_TERMS.exec(sentence);
      const sensitive = minor ? SENSITIVE_TERMS.exec(sentence) : null;
      if (minor && sensitive) return { category: 'minor', term: `${minor[0]} ... ${sensitive[0]}` };
    }

    // 3. Brands, logos and characters of other companies.
    const brand = BRANDS_RE.exec(text);
    if (brand) return { category: 'brand', term: brand[0] };
  }
  return null;
}

const REFUSALS: Record<SafetyCategory, (term: string) => { message: string; suggestion: string }> = {
  real_person: (term) => ({
    message: `I can't create images that show a real, identifiable person ("${term}").`,
    suggestion: 'Describe a fictional or generic person instead (for example "a smiling woman in her 30s"), or edit the user\'s own photo.',
  }),
  minor: () => ({
    message: "I can't create images of children or teenagers in that kind of situation.",
    suggestion: 'Rewrite the idea without that context, or use a different subject.',
  }),
  brand: (term) => ({
    message: `I can't use other companies' logos, brands or characters ("${term}").`,
    suggestion: 'Describe the object in generic terms (for example "running shoes" instead of a brand name) and add the user\'s own logo with compose_post.',
  }),
};

/** Throws a plain-language `UserFacingError` when the request should not reach a provider. */
export function assertPromptAllowed(task: SafetyTask, texts: readonly (string | undefined)[]): void {
  const issue = findSafetyIssue(task, texts);
  if (!issue) return;
  const refusal = REFUSALS[issue.category](issue.term);
  throw new UserFacingError(`safety_${issue.category}`, refusal.message, refusal.suggestion);
}
