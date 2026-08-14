/**
 * Free-text entry on four buttons - see text-entry.h
 */

#include "text-entry.h"

#include <stdio.h>
#include <string.h>

#include "memzero.h"

/* See text_entry_set_blocks(). Defaults off, and is driven by the same setting
 * as the seed-word selector - one decision about how the buttons behave, not
 * two. */
static bool blocks_enabled = false;

void text_entry_set_blocks(bool enabled) { blocks_enabled = enabled; }
bool text_entry_blocks_enabled(void) { return blocks_enabled; }

static const char LOWER[]  = "abcdefghijklmnopqrstuvwxyz";
static const char UPPER[]  = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/* Digits first, then the punctuation people actually use in passphrases.
 * Space is included and shown as an explicit glyph, because a trailing space
 * is invisible and changes the wallet. */
static const char SYMBOL[] = "0123456789 .,-_!?@#$%&*+=/:;'\"()[]{}<>^~`|\\";

/* Trailing entries in every ring, in a fixed order so muscle memory works:
 * the two character sets the user is not currently in, then DEL, then OK. */
#define TRAILING 4

static const char *charset(const TextEntry *e)
{
    switch (e->set) {
        case TEXT_SET_UPPER:  return UPPER;
        case TEXT_SET_SYMBOL: return SYMBOL;
        default:              return LOWER;
    }
}

void text_entry_reset(TextEntry *e)
{
    memzero(e, sizeof(*e));
    e->set = TEXT_SET_LOWER;
    e->option_index = 0;
    e->in_group = false;
}

int text_entry_group_size(const TextEntry *e)
{
    if (!blocks_enabled) {
        return 0;
    }

    int n = text_entry_option_count(e);
    if (n <= TEXT_ENTRY_GROUP_MIN) {
        return 0;
    }

    /* Blocks of about sqrt(n), the size that minimises "scroll to the block"
     * plus "scroll inside it". */
    int g = 1;
    while (g * g < n) {
        g++;
    }
    return g;
}

bool text_entry_on_group(const TextEntry *e)
{
    return text_entry_group_size(e) > 0 && !e->in_group;
}

/* Bounds of the block holding option_index; the whole ring when flat. */
static void group_bounds(const TextEntry *e, int *start, int *end)
{
    int n = text_entry_option_count(e);
    int g = text_entry_group_size(e);

    if (g <= 0) {
        *start = 0;
        *end = n;
        return;
    }
    *start = (e->option_index / g) * g;
    *end = *start + g;
    if (*end > n) {
        *end = n;
    }
}

int text_entry_option_count(const TextEntry *e)
{
    return (int)strlen(charset(e)) + TRAILING;
}

char text_entry_option_at(const TextEntry *e, int index)
{
    const char *set = charset(e);
    int n = (int)strlen(set);

    if (index < 0 || index >= n + TRAILING) {
        return TEXT_ENTRY_OK;
    }
    if (index < n) {
        return set[index];
    }

    switch (index - n) {
        /* The two sets the user is not in, so every set is one switch away.
         * A single cycling entry was shorter by one slot and charged two
         * switches to reach the symbols from lowercase - and the symbols are
         * where digits live, which is most of what a passphrase mixes in. */
        case 0:
            return (e->set == TEXT_SET_LOWER) ? TEXT_ENTRY_MODE_CAPS
                                              : TEXT_ENTRY_MODE_ABC;
        case 1:
            return (e->set == TEXT_SET_SYMBOL) ? TEXT_ENTRY_MODE_CAPS
                                               : TEXT_ENTRY_MODE_NUM;
        case 2:  return TEXT_ENTRY_DEL;
        default: return TEXT_ENTRY_OK;
    }
}

char text_entry_option(const TextEntry *e)
{
    return text_entry_option_at(e, e->option_index);
}

void text_entry_scroll(TextEntry *e, int dir)
{
    int n = text_entry_option_count(e);
    int g = text_entry_group_size(e);

    /* Coarse level: one press moves a whole block. */
    if (text_entry_on_group(e)) {
        int blocks = (n + g - 1) / g;
        int here = e->option_index / g;
        int next = ((here + dir) % blocks + blocks) % blocks;
        e->option_index = next * g;
        return;
    }

    /* Fine level: wrap inside the open block, so the characters the user is
     * looking at are the only ones one press away. */
    int start, end;
    group_bounds(e, &start, &end);
    int span = end - start;
    if (span <= 0) {
        return;
    }
    int rel = e->option_index - start;
    e->option_index = start + ((rel + dir) % span + span) % span;
}

bool text_entry_backspace(TextEntry *e)
{
    if (e->length <= 0) {
        return false;
    }
    e->text[--e->length] = '\0';
    return true;
}

TextEntryResult text_entry_accept(TextEntry *e)
{
    /* Opening a block is a navigation step, never an entry: nothing is typed
     * and nothing is confirmed until the user picks a single option. */
    if (text_entry_on_group(e)) {
        e->in_group = true;
        return TEXT_ENTRY_CONTINUE;
    }

    char option = text_entry_option(e);

    /* Every path below leaves the block level, so the next press scrolls in
     * whole blocks again. Leaving a block open after a character would make
     * the very next press mean something different depending on history. */
    e->in_group = false;

    switch (option) {
        case TEXT_ENTRY_MODE_ABC:
            e->set = TEXT_SET_LOWER;
            e->option_index = 0;
            return TEXT_ENTRY_CONTINUE;
        case TEXT_ENTRY_MODE_CAPS:
            e->set = TEXT_SET_UPPER;
            e->option_index = 0;
            return TEXT_ENTRY_CONTINUE;
        case TEXT_ENTRY_MODE_NUM:
            e->set = TEXT_SET_SYMBOL;
            e->option_index = 0;
            return TEXT_ENTRY_CONTINUE;

        case TEXT_ENTRY_DEL:
            if (!text_entry_backspace(e)) {
                return TEXT_ENTRY_CANCELLED;
            }
            return TEXT_ENTRY_CONTINUE;

        case TEXT_ENTRY_OK:
            /* An empty passphrase is a legitimate choice - it is the base
             * wallet - so OK on an empty buffer is DONE, not cancel. */
            return TEXT_ENTRY_DONE;

        default:
            if (e->length < TEXT_ENTRY_MAX) {
                e->text[e->length++] = option;
                e->text[e->length] = '\0';
            }
            return TEXT_ENTRY_CONTINUE;
    }
}

bool text_entry_back(TextEntry *e)
{
    /* Inside a block, CANCEL is "wrong block" - undoing a navigation step must
     * not delete a character the user did type. */
    if (text_entry_group_size(e) > 0 && e->in_group) {
        int start, end;
        group_bounds(e, &start, &end);
        e->option_index = start;
        e->in_group = false;
        return true;
    }

    return text_entry_backspace(e);
}

void text_entry_label_offset(const TextEntry *e, int offset, char *out, size_t len)
{
    if (len == 0) {
        return;
    }
    out[0] = '\0';

    int n = text_entry_option_count(e);
    int g = text_entry_group_size(e);
    char scratch[4];

    if (text_entry_on_group(e)) {
        int blocks = (n + g - 1) / g;
        int here = e->option_index / g;
        int want = ((here + offset) % blocks + blocks) % blocks;
        int start = want * g;
        int end = (start + g > n) ? n : start + g;

        const char *lo = text_entry_option_label(text_entry_option_at(e, start),
                                                 scratch, sizeof(scratch));
        char lo_copy[4];
        snprintf(lo_copy, sizeof(lo_copy), "%s", lo);
        const char *hi = text_entry_option_label(text_entry_option_at(e, end - 1),
                                                 scratch, sizeof(scratch));

        if (end - start == 1) {
            snprintf(out, len, "%s", lo_copy);
        } else {
            snprintf(out, len, "%s-%s", lo_copy, hi);
        }
        return;
    }

    int start, end;
    group_bounds(e, &start, &end);
    int span = end - start;
    if (span <= 0) {
        return;
    }
    int rel = ((e->option_index - start + offset) % span + span) % span;
    snprintf(out, len, "%s",
             text_entry_option_label(text_entry_option_at(e, start + rel),
                                     scratch, sizeof(scratch)));
}

const char *text_entry_option_label(char option, char *scratch, size_t scratch_size)
{
    switch (option) {
        case TEXT_ENTRY_MODE_ABC:  return "abc";
        case TEXT_ENTRY_MODE_CAPS: return "ABC";
        case TEXT_ENTRY_MODE_NUM:  return "123";
        case TEXT_ENTRY_DEL:       return "DEL";
        case TEXT_ENTRY_OK:        return "OK";
        case ' ':                  return "SP";   /* an invisible space is a trap */
        default:
            if (scratch_size >= 2) {
                scratch[0] = option;
                scratch[1] = '\0';
                return scratch;
            }
            return "?";
    }
}

void text_entry_clear(TextEntry *e)
{
    memzero(e->text, sizeof(e->text));
    e->length = 0;
}
