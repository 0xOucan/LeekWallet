/**
 * LeekWallet BIP39 Word Entry - see mnemonic-entry.h
 */

#include "mnemonic-entry.h"

#include <stdio.h>
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

/* Collect the words matching `prefix` into out[], giving up once more than
 * `cap` of them exist (the caller then knows the list is too long to show). */
static int collect_matches(const char *prefix, int len, int cap, uint16_t *out)
{
    int n = 0;

    for (int i = 0; i < BIP39_WORDS; i++) {
        if (strncmp(mnemonic_get_word(i), prefix, (size_t)len) != 0) {
            continue;
        }
        if (n == cap) {
            return cap + 1;
        }
        out[n++] = (uint16_t)i;
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
    e->word_mode = false;
    e->option_count = 0;
    e->option_index = 0;
    e->group_size = 0;
    e->in_group = false;

    /* Word phase: once the shortlist is short enough, offer the words. Typing
     * the remaining letters can only cost more presses than scrolling this
     * list, and every candidate is a real word, so no option is a dead end.
     *
     * The list is alphabetical, so when the prefix is itself a word it sorts
     * ahead of everything that extends it and lands on index 0 - "add" stays a
     * single press even though "addict" and "address" share its prefix. */
    if (e->prefix_len > 0) {
        int n = collect_matches(e->prefix, e->prefix_len,
                                MNEMONIC_ENTRY_WORD_MODE_MAX, e->candidates);
        if (n > 0 && n <= MNEMONIC_ENTRY_WORD_MODE_MAX) {
            e->word_mode = true;
            for (int i = 0; i < n; i++) {
                e->options[i] = MNEMONIC_ENTRY_COMMIT;
            }
            e->option_count = n;
            e->option_index = 0;
            return;
        }
    }

    /* The completion mask is all 26 bits for an empty prefix, but no BIP39 word
     * starts with 'x' - offering it charged the user a scroll step for a letter
     * that could never be typed. Confirm each letter against the wordlist. */
    uint32_t mask = mnemonic_word_completion_mask(e->prefix, e->prefix_len);
    for (int i = 0; i < 26; i++) {
        if (!(mask & (1u << i))) {
            continue;
        }
        char probe[MNEMONIC_ENTRY_WORD_LEN + 1];
        memcpy(probe, e->prefix, (size_t)e->prefix_len);
        probe[e->prefix_len] = (char)('a' + i);
        probe[e->prefix_len + 1] = '\0';
        if (count_matches(probe, e->prefix_len + 1, 1, NULL) == 0) {
            continue;
        }
        e->options[e->option_count++] = (char)('a' + i);
    }

    /* Offer COMMIT when the prefix can resolve to a word: either it is one
     * already, or exactly one word still matches it. (A unique match is
     * normally the word phase's job; this stays as the belt-and-braces path
     * for a prefix that is a word with more extensions than the word phase
     * will list.) */
    bool exact = (e->prefix_len > 0 && mnemonic_find_word(e->prefix) >= 0);
    bool unique = (e->prefix_len > 0 &&
                   count_matches(e->prefix, e->prefix_len, 2, NULL) == 1);

    if (exact || unique) {
        e->options[e->option_count++] = MNEMONIC_ENTRY_COMMIT;
    }

    /* An empty prefix always has 26 viable letters, so this can only be hit
     * if the wordlist is corrupt. Keep the selector non-empty regardless. */
    if (e->option_count == 0) {
        e->options[e->option_count++] = MNEMONIC_ENTRY_COMMIT;
    }

    /* Split a long list into blocks of about sqrt(n), which is the size that
     * minimises "scroll to the block" plus "scroll inside it". */
    if (e->option_count > MNEMONIC_ENTRY_GROUP_MIN) {
        int g = 1;
        while (g * g < e->option_count) {
            g++;
        }
        e->group_size = g;
    }
}

/* Number of blocks the option list is split into (1 when it is flat). */
static int group_count(const MnemonicEntry *e)
{
    if (e->group_size <= 0) {
        return 1;
    }
    return (e->option_count + e->group_size - 1) / e->group_size;
}

/* Bounds of the block holding option_index; the whole list when flat. */
static void group_bounds(const MnemonicEntry *e, int *start, int *end)
{
    if (e->group_size <= 0) {
        *start = 0;
        *end = e->option_count;
        return;
    }
    *start = (e->option_index / e->group_size) * e->group_size;
    *end = *start + e->group_size;
    if (*end > e->option_count) {
        *end = e->option_count;
    }
}

bool mnemonic_entry_on_group(const MnemonicEntry *e)
{
    return e->group_size > 0 && !e->in_group;
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

    /* Coarse level: one press moves a whole block. */
    if (mnemonic_entry_on_group(e)) {
        int blocks = group_count(e);
        int here = e->option_index / e->group_size;
        int next = ((here + dir) % blocks + blocks) % blocks;
        e->option_index = next * e->group_size;
        return;
    }

    /* Fine level: wrap inside the open block, so the letters the user is
     * looking at are the only ones one press away. */
    int start, end;
    group_bounds(e, &start, &end);
    int span = end - start;
    int rel = e->option_index - start;
    e->option_index = start + ((rel + dir) % span + span) % span;
}

char mnemonic_entry_option(const MnemonicEntry *e)
{
    if (e->option_count <= 0) {
        return MNEMONIC_ENTRY_COMMIT;
    }
    return e->options[e->option_index];
}

const char *mnemonic_entry_selected_word(const MnemonicEntry *e)
{
    if (!e->word_mode || e->option_index < 0 || e->option_index >= e->option_count) {
        return NULL;
    }
    return mnemonic_get_word(e->candidates[e->option_index]);
}

void mnemonic_entry_option_label(const MnemonicEntry *e, char *out, size_t len)
{
    if (len == 0) {
        return;
    }
    out[0] = '\0';

    const char *word = mnemonic_entry_selected_word(e);
    if (word) {
        snprintf(out, len, "%s", word);
        return;
    }

    if (mnemonic_entry_on_group(e)) {
        int start, end;
        group_bounds(e, &start, &end);
        char lo = e->options[start];
        char hi = e->options[end - 1];
        /* A block that ends on COMMIT is shown by its letters plus OK, since
         * "d-\n" would be nonsense on screen. */
        if (hi == MNEMONIC_ENTRY_COMMIT) {
            if (end - start == 1) {
                snprintf(out, len, "OK");
            } else {
                snprintf(out, len, "%c-%c OK", lo, e->options[end - 2]);
            }
        } else if (lo == hi) {
            snprintf(out, len, "%c", lo);
        } else {
            snprintf(out, len, "%c-%c", lo, hi);
        }
        return;
    }

    char option = mnemonic_entry_option(e);
    if (option == MNEMONIC_ENTRY_COMMIT) {
        snprintf(out, len, "OK");
    } else {
        snprintf(out, len, "%c", option);
    }
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

    /* Opening a block is a navigation step, never an entry: nothing is typed
     * and nothing is committed until the user picks a single option. */
    if (mnemonic_entry_on_group(e)) {
        e->in_group = true;
        return MNEMONIC_ENTRY_CONTINUE;
    }

    /* Word phase: commit exactly the word the screen is showing. */
    const char *picked = mnemonic_entry_selected_word(e);
    if (picked) {
        return commit_word(e, picked);
    }

    char option = mnemonic_entry_option(e);

    /* Explicit commit: the unique remaining word, or the prefix itself. */
    if (option == MNEMONIC_ENTRY_COMMIT) {
        const char *only = NULL;
        if (e->prefix_len > 0 &&
            count_matches(e->prefix, e->prefix_len, 2, &only) == 1 && only) {
            return commit_word(e, only);
        }
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

    /*
     * Nothing commits without the user confirming it.
     *
     * Auto-committing on a unique match reads well and fails badly. The
     * selector only offers viable letters, so neighbours are arbitrary: after
     * "po" the options are e,i,l,n,o,p,r,s,t,v,w, and 'p' sits directly beside
     * 's'. Over-scrolling by one while aiming for "post" lands on "pop", which
     * uniquely matches "popular" and was committed instantly with no prompt.
     * The user then discovers the mistake twelve words later as a checksum
     * failure that names no word.
     *
     * So a unique match surfaces COMMIT pre-highlighted instead. Confirming
     * costs one press, and a wrong turn costs one CANCEL rather than a silent
     * wrong seed.
     */
    rebuild_options(e);
    return MNEMONIC_ENTRY_CONTINUE;
}

bool mnemonic_entry_back(MnemonicEntry *e)
{
    /* Inside a block, BACK is "wrong block" - undoing a navigation step must
     * not delete a character the user did type. */
    if (e->in_group) {
        int start, end;
        group_bounds(e, &start, &end);
        e->option_index = start;
        e->in_group = false;
        return true;
    }

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
