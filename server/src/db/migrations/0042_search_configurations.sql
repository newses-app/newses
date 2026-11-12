-- Search folds accents (unaccent), and stems words in the entry's language: newses_simple for every
-- entry, newses_<language> for entries in a language with a Snowball stemmer.
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_simple (COPY = simple);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_simple ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, simple;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_arabic (COPY = arabic);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_arabic ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, arabic_stem;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_armenian (COPY = armenian);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_armenian ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, armenian_stem;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_danish (COPY = danish);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_danish ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, danish_stem;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_dutch (COPY = dutch);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_dutch ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, dutch_stem;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_english (COPY = english);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_english ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, english_stem;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_finnish (COPY = finnish);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_finnish ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, finnish_stem;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_french (COPY = french);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_french ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, french_stem;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_german (COPY = german);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_german ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, german_stem;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_greek (COPY = greek);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_greek ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, greek_stem;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_hungarian (COPY = hungarian);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_hungarian ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, hungarian_stem;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_indonesian (COPY = indonesian);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_indonesian ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, indonesian_stem;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_irish (COPY = irish);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_irish ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, irish_stem;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_italian (COPY = italian);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_italian ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, italian_stem;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_lithuanian (COPY = lithuanian);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_lithuanian ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, lithuanian_stem;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_nepali (COPY = nepali);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_nepali ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, nepali_stem;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_norwegian (COPY = norwegian);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_norwegian ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, norwegian_stem;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_portuguese (COPY = portuguese);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_portuguese ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, portuguese_stem;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_romanian (COPY = romanian);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_romanian ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, romanian_stem;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_russian (COPY = russian);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_russian ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, russian_stem;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_serbian (COPY = serbian);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_serbian ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, serbian_stem;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_spanish (COPY = spanish);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_spanish ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, spanish_stem;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_swedish (COPY = swedish);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_swedish ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, swedish_stem;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_tamil (COPY = tamil);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_tamil ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, tamil_stem;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION newses_turkish (COPY = turkish);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION newses_turkish ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part WITH unaccent, turkish_stem;
