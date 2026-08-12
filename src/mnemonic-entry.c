/**
 * LeekWallet BIP39 Word Entry - see mnemonic-entry.h
 */

#include "mnemonic-entry.h"

#include <string.h>

#include "bip39.h"
#include "memzero.h"

#define BIP39_WORDS 2048

/* Count words matching `prefix`, stopping once `cap` is reached.
 * Writes the first match to *first when non-NULL. */
static int count_matches(const char *prefix, int len, int cap, const char **first)
{
    int n = 0;

    if (first) {
        *first = NULL;
    }

    for (int i = 0; i < BIP39_WORDS; i++) {
        const char *word = mnemonic_get_word(i);
        if (strncmp(word, prefix, (size_t)len) != 0) {
            continue;
        }
        if (n == 0 && first) {
            *first = word;
        }
        if (++n >= cap) {
            break;
        }
    }

    return n;
}

/* Rebuild the selector from the current prefix.
 *
 * Only letters that can still lead to a real word are offered, which makes
 * dead-end keystrokes impossible. COMMIT is offered whenever the prefix is
 * itself a BIP39 word - without it, any word that is a proper prefix of a
 * longer word would be unreachable. */
static void rebuild_options(MnemonicEntry *e)
{
    char previous = (e->option_count > 0) ? e->options[e->option_index] : '\0';

    e->option_count = 0;

    uint32_t mask = mnemonic_word_completion_mask(e->prefix, e->prefix_len);
    for (int i = 0; i < 26; i++) {
        if (mask & (1u << i)) {
            e->options[e->option_count++] = (char)('a' + i);
        }
    }

    if (e->prefix_len > 0 && mnemonic_find_word(e->prefix) >= 0) {
        e->options[e->option_count++] = MNEMONIC_ENTRY_COMMIT;
    }

    /* An empty prefix always has 26 viable letters, so this can only be hit
     * if the wordlist is corrupt. Keep the selector non-empty regardless. */
    if (e->option_count == 0) {
        e->options[e->option_count++] = MNEMONIC_ENTRY_COMMIT;
    }

    /* Keep the highlight on the same option across a rebuild when possible. */
    e->option_index = 0;
    if (previous != '\0') {
        for (int i = 0; i < e->option_count; i++) {
            if (e->options[i] == previous) {
                e->option_index = i;
                break;
            }
        }
    }
}

void mnemonic_entry_reset(MnemonicEntry *e, int target_words)
{
    memzero(e, sizeof(*e));
    e->target_words = (target_words == 24) ? 24 : 12;
    rebuild_options(e);
}

void mnemonic_entry_scroll(MnemonicEntry *e, int dir)
{
    if (e->option_count <= 0) {
        return;
    }
    int n = e->option_count;
    e->option_index = ((e->option_index + dir) % n + n) % n;
}

char mnemonic_entry_option(const MnemonicEntry *e)
{
    if (e->option_count <= 0) {
        return MNEMONIC_ENTRY_COMMIT;
    }
    return e->options[e->option_index];
}

const char *mnemonic_entry_suggestion(const MnemonicEntry *e)
{
    if (e->prefix_len == 0) {
        return NULL;
    }
    return mnemonic_complete_word(e->prefix, e->prefix_len);
}

int mnemonic_entry_match_count(const MnemonicEntry *e, int cap)
{
    return count_matches(e->prefix, e->prefix_len, cap, NULL);
}

/* Store `word` as the current word and advance. */
static MnemonicEntryResult commit_word(MnemonicEntry *e, const char *word)
{
    strncpy(e->words[e->current_word], word, MNEMONIC_ENTRY_WORD_LEN - 1);
    e->words[e->current_word][MNEMONIC_ENTRY_WORD_LEN - 1] = '\0';

    e->current_word++;
    e->word_count = e->current_word;

    memzero(e->prefix, sizeof(e->prefix));
    e->prefix_len = 0;
    e->option_count = 0;   /* drop the highlight; next word starts fresh */
    rebuild_options(e);

    return (e->word_count >= e->target_words) ? MNEMONIC_ENTRY_ALL_DONE
                                              : MNEMONIC_ENTRY_WORD_DONE;
}

MnemonicEntryResult mnemonic_entry_accept(MnemonicEntry *e)
{
    if (e->current_word >= e->target_words) {
        return MNEMONIC_ENTRY_ALL_DONE;
    }

    char option = mnemonic_entry_option(e);

    /* Explicit commit: only valid when the prefix is a complete word. */
    if (option == MNEMONIC_ENTRY_COMMIT) {
        if (e->prefix_len > 0 && mnemonic_find_word(e->prefix) >= 0) {
            return commit_word(e, e->prefix);
        }
        return MNEMONIC_ENTRY_CONTINUE;
    }

    if (e->prefix_len >= MNEMONIC_ENTRY_WORD_LEN - 1) {
        return MNEMONIC_ENTRY_CONTINUE;
    }

    e->prefix[e->prefix_len++] = option;
    e->prefix[e->prefix_len] = '\0';

    /* Auto-commit only when the prefix is unambiguous. Committing on "is a
     * valid word" alone is what made 110 words unreachable. */
    const char *only = NULL;
    if (count_matches(e->prefix, e->prefix_len, 2, &only) == 1 && only) {
        return commit_word(e, only);
    }

    rebuild_options(e);
    return MNEMONIC_ENTRY_CONTINUE;
}

bool mnemonic_entry_back(MnemonicEntry *e)
{
    if (e->prefix_len > 0) {
        e->prefix[--e->prefix_len] = '\0';
        e->option_count = 0;
        rebuild_options(e);
        return true;
    }

    if (e->current_word > 0) {
        /* Reopen the previous word for editing, minus its last character so
         * the user is not immediately re-committed by the auto-accept rule. */
        e->current_word--;
        e->word_count = e->current_word;

        strncpy(e->prefix, e->words[e->current_word], MNEMONIC_ENTRY_WORD_LEN - 1);
        e->prefix[MNEMONIC_ENTRY_WORD_LEN - 1] = '\0';
        e->prefix_len = (int)strlen(e->prefix);
        if (e->prefix_len > 0) {
            e->prefix[--e->prefix_len] = '\0';
        }

        memzero(e->words[e->current_word], MNEMONIC_ENTRY_WORD_LEN);
        e->option_count = 0;
        rebuild_options(e);
        return true;
    }

    return false;
}

void mnemonic_entry_build(const MnemonicEntry *e, char *out, size_t max_len)
{
    if (max_len == 0) {
        return;
    }

    out[0] = '\0';
    for (int i = 0; i < e->word_count; i++) {
        size_t used = strlen(out);
        if (used + 1 >= max_len) {
            break;
        }
        if (i > 0) {
            strncat(out, " ", max_len - used - 1);
            used = strlen(out);
        }
        strncat(out, e->words[i], max_len - used - 1);
    }
}

void mnemonic_entry_clear(MnemonicEntry *e)
{
    int target = e->target_words;
    memzero(e, sizeof(*e));
    e->target_words = target;
    rebuild_options(e);
}
