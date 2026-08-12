/**
 * LeekWallet BIP39 Word Entry
 *
 * Pure logic for typing a seed phrase on a 4-button device. No ESP-IDF
 * dependencies, so it can be exercised by the host test harness in sim/.
 *
 * Entry model: the user cycles a selector through the letters that can still
 * lead to a real BIP39 word, and confirms one at a time. A word commits either
 * automatically (when only one word can still match) or explicitly (via the
 * COMMIT option, which appears whenever the typed prefix is itself a valid
 * BIP39 word). The explicit option is what makes words like "add" reachable
 * even though "addict" and "address" extend them.
 */

#ifndef MNEMONIC_ENTRY_H
#define MNEMONIC_ENTRY_H

#include <stdbool.h>
#include <stddef.h>

#define MNEMONIC_ENTRY_MAX_WORDS   24
#define MNEMONIC_ENTRY_WORD_LEN    10   /* longest BIP39 word is 8 chars + NUL */
#define MNEMONIC_ENTRY_MAX_OPTIONS 27   /* 26 letters + COMMIT */

/* Sentinel stored in options[] for "commit the prefix as-is". */
#define MNEMONIC_ENTRY_COMMIT '\n'

typedef struct {
    char words[MNEMONIC_ENTRY_MAX_WORDS][MNEMONIC_ENTRY_WORD_LEN];
    int  word_count;      /* words committed so far */
    int  current_word;    /* index being typed */
    int  target_words;    /* 12 or 24 */

    char prefix[MNEMONIC_ENTRY_WORD_LEN];
    int  prefix_len;

    /* Selector: viable next letters, plus COMMIT when the prefix is a word. */
    char options[MNEMONIC_ENTRY_MAX_OPTIONS];
    int  option_count;
    int  option_index;
} MnemonicEntry;

typedef enum {
    MNEMONIC_ENTRY_CONTINUE,   /* still typing */
    MNEMONIC_ENTRY_WORD_DONE,  /* a word was committed, more remain */
    MNEMONIC_ENTRY_ALL_DONE,   /* target_words reached */
} MnemonicEntryResult;

/** Reset to an empty phrase. target_words is clamped to 12 or 24. */
void mnemonic_entry_reset(MnemonicEntry *e, int target_words);

/** Move the selector. dir is +1 or -1; wraps. */
void mnemonic_entry_scroll(MnemonicEntry *e, int dir);

/** Currently selected option: a lowercase letter, or MNEMONIC_ENTRY_COMMIT. */
char mnemonic_entry_option(const MnemonicEntry *e);

/** Apply the selected option (append a letter, or commit the prefix). */
MnemonicEntryResult mnemonic_entry_accept(MnemonicEntry *e);

/**
 * Undo: drop a character, or step back to the previous word.
 * Returns false when there is nothing left to undo (caller should exit).
 */
bool mnemonic_entry_back(MnemonicEntry *e);

/** First word matching the current prefix, or NULL. For display only. */
const char *mnemonic_entry_suggestion(const MnemonicEntry *e);

/** How many BIP39 words match the current prefix. Counts up to `cap`. */
int mnemonic_entry_match_count(const MnemonicEntry *e, int cap);

/** Join committed words with spaces into `out`. */
void mnemonic_entry_build(const MnemonicEntry *e, char *out, size_t max_len);

/** Zero every buffer. Call as soon as the phrase has been consumed. */
void mnemonic_entry_clear(MnemonicEntry *e);

#endif /* MNEMONIC_ENTRY_H */
