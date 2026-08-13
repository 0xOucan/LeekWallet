/**
 * Free-text entry on four buttons.
 *
 * Used for the BIP39 passphrase, which unlike a seed word has no wordlist to
 * constrain it: any UTF-8 string is valid, so nothing can be predicted and
 * every character must be selected outright.
 *
 * Fifty-two letters plus digits and symbols in one linear cycle would be
 * unusable, so the selector carries *mode entries* alongside the characters —
 * the same trick that makes OK work on the PIN and mnemonic screens:
 *
 *     a b c ... z  [A]  [123]  [DEL]  [OK]
 *                   ^     ^
 *            case toggle  symbol set
 *
 * Picking [A] switches the letter set in place rather than adding a shift
 * button, so the four physical buttons keep one meaning everywhere in the UI.
 *
 * No ESP-IDF dependency: the host suite drives this directly.
 */

#ifndef TEXT_ENTRY_H
#define TEXT_ENTRY_H

#include <stdbool.h>
#include <stddef.h>

#define TEXT_ENTRY_MAX 64

/* Mode entries live in the same ring as characters and are distinguished by
 * being outside the printable ASCII range. */
#define TEXT_ENTRY_MODE_ABC  '\x01'   /* switch to lowercase */
#define TEXT_ENTRY_MODE_CAPS '\x02'   /* switch to uppercase */
#define TEXT_ENTRY_MODE_NUM  '\x03'   /* switch to digits and symbols */
#define TEXT_ENTRY_DEL       '\x04'
#define TEXT_ENTRY_OK        '\x05'

typedef enum {
    TEXT_SET_LOWER,
    TEXT_SET_UPPER,
    TEXT_SET_SYMBOL,
} TextCharSet;

typedef struct {
    char text[TEXT_ENTRY_MAX + 1];
    int  length;

    TextCharSet set;
    int         option_index;
} TextEntry;

typedef enum {
    TEXT_ENTRY_CONTINUE,
    TEXT_ENTRY_DONE,      /* the user picked OK */
    TEXT_ENTRY_CANCELLED, /* deleted past the first character */
} TextEntryResult;

void text_entry_reset(TextEntry *e);

/** Number of options in the current ring. */
int text_entry_option_count(const TextEntry *e);

/** Option at `index` in the current ring: a character, or a mode sentinel. */
char text_entry_option_at(const TextEntry *e, int index);

/** Currently highlighted option. */
char text_entry_option(const TextEntry *e);

/** Move the highlight. dir is +1 or -1; wraps. */
void text_entry_scroll(TextEntry *e, int dir);

/** Apply the highlighted option. */
TextEntryResult text_entry_accept(TextEntry *e);

/** Delete one character. Returns false when there is nothing left to delete. */
bool text_entry_backspace(TextEntry *e);

/** Human-readable label for an option, for rendering. */
const char *text_entry_option_label(char option, char *scratch, size_t scratch_size);

/** Wipe the buffer. Call as soon as the text has been consumed. */
void text_entry_clear(TextEntry *e);

#endif /* TEXT_ENTRY_H */
