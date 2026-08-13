/**
 * Free-text entry on four buttons - see text-entry.h
 */

#include "text-entry.h"

#include <string.h>

#include "memzero.h"

static const char LOWER[]  = "abcdefghijklmnopqrstuvwxyz";
static const char UPPER[]  = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/* Digits first, then the punctuation people actually use in passphrases.
 * Space is included and shown as an explicit glyph, because a trailing space
 * is invisible and changes the wallet. */
static const char SYMBOL[] = "0123456789 .,-_!?@#$%&*+=/:;'\"()[]{}<>^~`|\\";

/* Trailing entries in every ring, in a fixed order so muscle memory works. */
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
        case 0:
            /* Cycles lower -> upper -> symbols -> lower. One entry rather than
             * three keeps the ring short. */
            if (e->set == TEXT_SET_LOWER)  return TEXT_ENTRY_MODE_CAPS;
            if (e->set == TEXT_SET_UPPER)  return TEXT_ENTRY_MODE_NUM;
            return TEXT_ENTRY_MODE_ABC;
        case 1:  return TEXT_ENTRY_DEL;
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
    e->option_index = ((e->option_index + dir) % n + n) % n;
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
    char option = text_entry_option(e);

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
