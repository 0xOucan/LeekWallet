/**
 * Free-text entry tests (ROADMAP T38).
 *
 * The passphrase is the one credential with no wordlist behind it, so nothing
 * can be predicted and a single wrong character silently opens a different
 * wallet. These tests care about reachability - every character a user might
 * put in a passphrase must be typeable - and about the modes not losing text.
 */

#include <stdio.h>
#include <string.h>

#include "text-entry.h"

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

/* Type one character by scrolling to it, switching sets as needed. */
static bool type_char(TextEntry *e, char want, int *presses)
{
    for (int attempt = 0; attempt < 4; attempt++) {
        int n = text_entry_option_count(e);
        for (int i = 0; i < n; i++) {
            if (text_entry_option_at(e, i) == want) {
                /* Scroll whichever way is shorter. The device has UP and DOWN,
                 * and measuring one-directional travel would overstate the
                 * cost by roughly double. */
                int forward = (i - e->option_index + n) % n;
                int back = (e->option_index - i + n) % n;
                int dir = (forward <= back) ? 1 : -1;
                int steps = (forward <= back) ? forward : back;
                for (int k = 0; k < steps; k++) {
                    text_entry_scroll(e, dir);
                    if (presses) (*presses)++;
                }
                text_entry_accept(e);
                if (presses) (*presses)++;
                return true;
            }
        }
        /* Not in this set - cycle to the next one. */
        int mode_slot = -1;
        for (int i = 0; i < n; i++) {
            char o = text_entry_option_at(e, i);
            if (o == TEXT_ENTRY_MODE_ABC || o == TEXT_ENTRY_MODE_CAPS ||
                o == TEXT_ENTRY_MODE_NUM) {
                mode_slot = i;
                break;
            }
        }
        if (mode_slot < 0) return false;
        int fwd = (mode_slot - e->option_index + n) % n;
        int bck = (e->option_index - mode_slot + n) % n;
        int d = (fwd <= bck) ? 1 : -1;
        int st = (fwd <= bck) ? fwd : bck;
        for (int k = 0; k < st; k++) {
            text_entry_scroll(e, d);
            if (presses) (*presses)++;
        }
        text_entry_accept(e);
        if (presses) (*presses)++;
    }
    return false;
}

static void type_string(TextEntry *e, const char *s, int *presses)
{
    for (const char *p = s; *p; p++) {
        if (!type_char(e, *p, presses)) {
            CHECK(false, "character '%c' (0x%02x) is not reachable", *p, (unsigned char)*p);
            return;
        }
    }
}

static void test_every_printable_is_reachable(void)
{
    printf("== every printable ASCII character can be typed\n");

    int unreachable = 0;
    for (char c = 0x20; c < 0x7f; c++) {
        TextEntry e;
        text_entry_reset(&e);
        if (!type_char(&e, c, NULL)) {
            if (unreachable < 8) printf("  unreachable: '%c' (0x%02x)\n", c, (unsigned char)c);
            unreachable++;
        }
    }
    CHECK(unreachable == 0, "%d printable characters cannot be typed", unreachable);
}

static void test_mixed_passphrase(void)
{
    printf("== a realistic mixed passphrase round-trips\n");

    const char *target = "Correct-Horse 42!";
    TextEntry e;
    text_entry_reset(&e);

    int presses = 0;
    type_string(&e, target, &presses);

    CHECK(strcmp(e.text, target) == 0, "typed \"%s\", got \"%s\"", target, e.text);
    printf("  %zu characters in %d presses (%.1f per character)\n",
           strlen(target), presses, (double)presses / (double)strlen(target));
}

static void test_switching_sets_keeps_text(void)
{
    printf("== switching character sets does not lose text\n");

    TextEntry e;
    text_entry_reset(&e);
    type_string(&e, "aB3", NULL);
    CHECK(strcmp(e.text, "aB3") == 0, "text is \"%s\"", e.text);

    /* Cycle every set and confirm nothing was dropped. */
    for (int i = 0; i < 3; i++) {
        int n = text_entry_option_count(&e);
        for (int k = 0; k < n; k++) {
            char o = text_entry_option_at(&e, k);
            if (o == TEXT_ENTRY_MODE_ABC || o == TEXT_ENTRY_MODE_CAPS ||
                o == TEXT_ENTRY_MODE_NUM) {
                e.option_index = k;
                text_entry_accept(&e);
                break;
            }
        }
    }
    CHECK(strcmp(e.text, "aB3") == 0, "text became \"%s\" after mode changes", e.text);
}

static void test_backspace_and_cancel(void)
{
    printf("== backspace, and cancelling past the start\n");

    TextEntry e;
    text_entry_reset(&e);
    type_string(&e, "ab", NULL);

    CHECK(text_entry_backspace(&e), "backspace failed");
    CHECK(strcmp(e.text, "a") == 0, "after one backspace: \"%s\"", e.text);
    CHECK(text_entry_backspace(&e), "second backspace failed");
    CHECK(e.length == 0, "length is %d", e.length);
    CHECK(!text_entry_backspace(&e), "backspace on empty should report nothing to do");

    /* DEL on an empty buffer is how the user leaves the screen. */
    int n = text_entry_option_count(&e);
    for (int i = 0; i < n; i++) {
        if (text_entry_option_at(&e, i) == TEXT_ENTRY_DEL) { e.option_index = i; break; }
    }
    CHECK(text_entry_accept(&e) == TEXT_ENTRY_CANCELLED, "DEL on empty should cancel");
}

static void test_empty_is_done_not_cancel(void)
{
    printf("== an empty passphrase is a valid choice\n");

    /* No passphrase is the base wallet, so OK on an empty buffer must confirm
     * rather than refuse. */
    TextEntry e;
    text_entry_reset(&e);
    int n = text_entry_option_count(&e);
    for (int i = 0; i < n; i++) {
        if (text_entry_option_at(&e, i) == TEXT_ENTRY_OK) { e.option_index = i; break; }
    }
    CHECK(text_entry_accept(&e) == TEXT_ENTRY_DONE, "OK on empty should be DONE");
    CHECK(e.length == 0, "empty should stay empty");
}

static void test_length_cap(void)
{
    printf("== the buffer cannot be overrun\n");

    TextEntry e;
    text_entry_reset(&e);
    for (int i = 0; i < TEXT_ENTRY_MAX + 40; i++) {
        type_char(&e, 'x', NULL);
    }
    CHECK(e.length == TEXT_ENTRY_MAX, "length is %d, cap is %d", e.length, TEXT_ENTRY_MAX);
    CHECK(e.text[TEXT_ENTRY_MAX] == '\0', "buffer is not terminated");
}

static void test_space_is_visible(void)
{
    printf("== space renders as a glyph\n");

    /* A trailing space is invisible and changes the derived wallet, so the
     * selector must not show it as blank. */
    char scratch[4];
    CHECK(strcmp(text_entry_option_label(' ', scratch, sizeof(scratch)), "SP") == 0,
          "space is not labelled");
    CHECK(strcmp(text_entry_option_label('a', scratch, sizeof(scratch)), "a") == 0,
          "ordinary characters should render as themselves");
}

int main(void)
{
    test_every_printable_is_reachable();
    test_mixed_passphrase();
    test_switching_sets_keeps_text();
    test_backspace_and_cancel();
    test_empty_is_done_not_cancel();
    test_length_cap();
    test_space_is_visible();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
