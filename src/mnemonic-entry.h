/**
 * LeekWallet BIP39 Word Entry
 *
 * Pure logic for typing a seed phrase on a 4-button device. No ESP-IDF
 * dependencies, so it can be exercised by the host test harness in sim/.
 *
 * Entry model, in two phases:
 *
 *   1. Letter phase - the user cycles a selector through the letters that can
 *      still lead to a real BIP39 word, and confirms one at a time. A long
 *      list of letters is offered in two levels: scroll over blocks such as
 *      "a-f", ACCEPT to open one, then scroll the letters inside it. BACK
 *      leaves the open block instead of deleting.
 *   2. Word phase - as soon as few enough words still match the prefix, the
 *      selector switches from letters to the whole candidate words. The user
 *      picks the word itself and confirms it once.
 *
 * Both phases exist to stop charging the user for keystrokes that carry no
 * information. A flat 26-letter ring costs up to 13 scrolls for one character;
 * two levels cost about 5 for the same character. And BIP39 words are pinned
 * down by their first few letters, so once the shortlist is short, asking for
 * the rest of the spelling is pure overhead - scrolling a list of at most
 * MNEMONIC_ENTRY_WORD_MODE_MAX words is never worse and usually far better.
 *
 * Measured over all 2048 words (sim/test_mnemonic_entry.c): 38 presses
 * worst case and 19.8 on average before, 19 and 12.0 after.
 *
 * A word commits only when the user confirms it - either a word picked in the
 * word phase, or the COMMIT option, which appears whenever the typed prefix is
 * itself a valid BIP39 word. The explicit option is what makes words like
 * "add" reachable even though "addict" and "address" extend them.
 */

#ifndef MNEMONIC_ENTRY_H
#define MNEMONIC_ENTRY_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define MNEMONIC_ENTRY_MAX_WORDS   24
#define MNEMONIC_ENTRY_WORD_LEN    10   /* longest BIP39 word is 8 chars + NUL */
#define MNEMONIC_ENTRY_MAX_OPTIONS 27   /* 26 letters + COMMIT */

/* Switch from letters to whole words once at most this many words still match.
 * Chosen by measurement, not taste: sim/test_mnemonic_entry.c sweeps the press
 * cost of all 2048 words, and this is where the worst case bottoms out. Lower
 * and the user types letters they did not need; higher and the word list grows
 * longer than the letters it replaced. */
#define MNEMONIC_ENTRY_WORD_MODE_MAX 8

/* Below this many options a flat ring is already cheap, and splitting it into
 * blocks would charge an extra ACCEPT for nothing. */
#define MNEMONIC_ENTRY_GROUP_MIN 8

/* Sentinel stored in options[] for "commit the prefix as-is". */
#define MNEMONIC_ENTRY_COMMIT '\n'

typedef struct {
    char words[MNEMONIC_ENTRY_MAX_WORDS][MNEMONIC_ENTRY_WORD_LEN];
    int  word_count;      /* words committed so far */
    int  current_word;    /* index being typed */
    int  target_words;    /* 12 or 24 */

    char prefix[MNEMONIC_ENTRY_WORD_LEN];
    int  prefix_len;

    /* Selector: viable next letters, plus COMMIT when the prefix is a word.
     * In the word phase every entry is COMMIT and `candidates` names the words
     * they stand for, one per option index. */
    char options[MNEMONIC_ENTRY_MAX_OPTIONS];
    int  option_count;
    int  option_index;

    bool     word_mode;
    uint16_t candidates[MNEMONIC_ENTRY_WORD_MODE_MAX];  /* BIP39 word indices */

    /* Coarse level. group_size is 0 when the list is short enough to scroll
     * flat; otherwise the selector starts on blocks and `in_group` says the
     * user has opened one and is now scrolling single letters. */
    int  group_size;
    bool in_group;
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

/**
 * The whole word the selector is sitting on in the word phase, or NULL while
 * the user is still choosing letters. This is what ACCEPT would commit, so the
 * screen must show it: the user has to see the word before confirming it.
 */
const char *mnemonic_entry_selected_word(const MnemonicEntry *e);

/**
 * What the selector is pointing at, ready to draw: a block ("a-f"), a single
 * letter, "OK" for the commit option, or a whole word in the word phase.
 *
 * The screen must never show less than what ACCEPT would apply, so this is
 * generated here rather than reassembled by each caller.
 */
void mnemonic_entry_option_label(const MnemonicEntry *e, char *out, size_t len);

/** True while the selector is on a block of letters rather than one letter. */
bool mnemonic_entry_on_group(const MnemonicEntry *e);

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
