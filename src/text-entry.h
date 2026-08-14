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
 *     a b c ... z  [ABC]  [123]  [DEL]  [OK]
 *                    ^      ^
 *             other case     symbol set
 *
 * Picking [ABC] switches the letter set in place rather than adding a shift
 * button, so the four physical buttons keep one meaning everywhere in the UI.
 * Only the two sets the user is *not* in are offered, so every set is one
 * switch away and no option in the ring is inert.
 *
 * T60 - the block level. Even so, one flat ring of thirty options costs about
 * seven scrolls per character, and a seventeen-character passphrase then costs
 * over two hundred presses. That is a security problem wearing a usability
 * costume: it pushes people towards short guessable passphrases, or towards not
 * using the feature at all. So the ring can be split into blocks of about
 * sqrt(n) - scroll to the block, open it, scroll inside - which is the same
 * two-level selector src/mnemonic-entry.c uses for seed words.
 *
 * It is behind the same "Entry: Simple/Blocks" setting as the seed selector,
 * and deliberately not a second preference: a two-level selector is a mode, a
 * mode on four unlabelled buttons is a real cost, and a user who has decided
 * how they want to be asked for letters has decided it for both screens.
 *
 * No ESP-IDF dependency: the host suite drives this directly.
 */

#ifndef TEXT_ENTRY_H
#define TEXT_ENTRY_H

#include <stdbool.h>
#include <stddef.h>

#define TEXT_ENTRY_MAX 64

/* Below this many options a flat ring is already short enough that a block
 * level would cost a press (opening the block) to save fewer. */
#define TEXT_ENTRY_GROUP_MIN 8

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

    /* Coarse level: true once the user has opened a block and is choosing
     * inside it. Meaningless when blocks are off. */
    bool in_group;
} TextEntry;

typedef enum {
    TEXT_ENTRY_CONTINUE,
    TEXT_ENTRY_DONE,      /* the user picked OK */
    TEXT_ENTRY_CANCELLED, /* deleted past the first character */
} TextEntryResult;

/** Two-level selector on or off. Shared with the seed-word selector: this is
 *  set from the one "Entry" setting, never from a preference of its own. */
void text_entry_set_blocks(bool enabled);
bool text_entry_blocks_enabled(void);

void text_entry_reset(TextEntry *e);

/** Options per block, or 0 when the ring is scrolled flat. */
int text_entry_group_size(const TextEntry *e);

/** True while the selector is choosing a block rather than an option. */
bool text_entry_on_group(const TextEntry *e);

/** Label for the entry `offset` steps from the highlight (-1, 0 or +1), at
 *  whichever level the selector is on. Blocks render as "a-f". */
void text_entry_label_offset(const TextEntry *e, int offset, char *out, size_t len);

/** CANCEL: close an open block, else delete a character. False when there is
 *  nothing left to undo, which is how the user leaves the screen. */
bool text_entry_back(TextEntry *e);

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
