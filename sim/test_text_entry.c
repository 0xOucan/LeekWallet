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

/* Walk the selector onto option `to` and count the presses it takes.
 *
 * Models a real user: scroll whichever way is shorter (the ring wraps, so a
 * forward-only model would over-charge every option past the halfway mark),
 * and when the list is split into blocks, scroll to the block, open it, then
 * scroll inside it. The same model as test_mnemonic_entry.c, deliberately -
 * the two selectors are compared against each other. */
static void scroll_to(TextEntry *e, int to, int *presses)
{
    int n = text_entry_option_count(e);
    int g = text_entry_group_size(e);

    if (text_entry_on_group(e)) {
        int blocks = (n + g - 1) / g;
        int want = to / g;
        for (int guard = 0; e->option_index / g != want; guard++) {
            if (guard > 200) {
                CHECK(false, "block %d is not reachable", want);
                return;
            }
            int here = e->option_index / g;
            int fwd = ((want - here) % blocks + blocks) % blocks;
            text_entry_scroll(e, (fwd * 2 <= blocks) ? 1 : -1);
            if (presses) (*presses)++;
        }
        text_entry_accept(e);           /* open the block */
        if (presses) (*presses)++;
    }

    int start = 0, span = n;
    if (g > 0) {
        start = (e->option_index / g) * g;
        span = n - start;
        if (span > g) span = g;
    }

    /* Guarded: a selector that cannot reach an option is a bug to report, not
     * a reason for the suite to hang. A hang looks like an infrastructure
     * problem; a failure names the option. */
    for (int guard = 0; e->option_index != to; guard++) {
        if (guard > 200) {
            CHECK(false, "option %d is not reachable from %d", to, e->option_index);
            return;
        }
        int rel = e->option_index - start;
        int fwd = ((to - start - rel) % span + span) % span;
        text_entry_scroll(e, (fwd * 2 <= span) ? 1 : -1);
        if (presses) (*presses)++;
    }
}

/* Type one character by scrolling to it, switching sets as needed. */
static bool type_char(TextEntry *e, char want, int *presses)
{
    for (int attempt = 0; attempt < 4; attempt++) {
        int n = text_entry_option_count(e);
        for (int i = 0; i < n; i++) {
            if (text_entry_option_at(e, i) == want) {
                scroll_to(e, i, presses);
                text_entry_accept(e);
                if (presses) (*presses)++;
                return true;
            }
        }
        /* Not in this set - switch straight to the one that holds it. */
        char mode = TEXT_ENTRY_MODE_NUM;
        if (want >= 'a' && want <= 'z') mode = TEXT_ENTRY_MODE_ABC;
        if (want >= 'A' && want <= 'Z') mode = TEXT_ENTRY_MODE_CAPS;

        int mode_slot = -1;
        for (int i = 0; i < n; i++) {
            if (text_entry_option_at(e, i) == mode) {
                mode_slot = i;
                break;
            }
        }
        if (mode_slot < 0) return false;
        scroll_to(e, mode_slot, presses);
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

    /* Both selectors, because both ship. A block level that leaves one
     * character unreachable is a passphrase the user can never re-enter. */
    for (int blocks = 0; blocks < 2; blocks++) {
        text_entry_set_blocks(blocks != 0);

        int unreachable = 0;
        for (char c = 0x20; c < 0x7f; c++) {
            TextEntry e;
            text_entry_reset(&e);
            if (!type_char(&e, c, NULL) || e.length != 1 || e.text[0] != c) {
                if (unreachable < 8) {
                    printf("  unreachable: '%c' (0x%02x)\n", c, (unsigned char)c);
                }
                unreachable++;
            }
        }
        CHECK(unreachable == 0, "%s: %d printable characters cannot be typed",
              blocks ? "blocks" : "simple", unreachable);
    }

    text_entry_set_blocks(false);
}

/* T60. The block level is navigation, and navigation must never be entry.
 * Opening a block that happens to start on 'a' must not type an 'a', and
 * backing out of the wrong block must not eat the character before it. */
static void test_blocks_navigate_without_typing(void)
{
    printf("== opening and leaving a block types and deletes nothing\n");

    text_entry_set_blocks(true);

    TextEntry e;
    text_entry_reset(&e);
    CHECK(text_entry_on_group(&e), "the selector did not start on blocks");
    CHECK(text_entry_group_size(&e) > 0, "no block size with blocks on");

    text_entry_scroll(&e, 1);
    CHECK(text_entry_accept(&e) == TEXT_ENTRY_CONTINUE, "opening a block did not continue");
    CHECK(e.length == 0, "opening a block typed \"%s\"", e.text);
    CHECK(!text_entry_on_group(&e), "accept did not open the block");

    /* CANCEL inside the block is "wrong block", not "delete". */
    CHECK(text_entry_back(&e), "backing out of a block reported nothing to do");
    CHECK(text_entry_on_group(&e), "back() did not close the block");
    CHECK(e.length == 0, "back() out of a block changed the text");

    /* With text typed, the same press must still close the block first and
     * only then start deleting. */
    type_char(&e, 'a', NULL);
    CHECK(e.length == 1, "expected one character, got %d", e.length);
    text_entry_accept(&e);                  /* open whichever block is under us */
    CHECK(text_entry_back(&e) && e.length == 1,
          "closing a block deleted a character (\"%s\")", e.text);
    CHECK(text_entry_back(&e) && e.length == 0, "the character was not deleted");

    text_entry_set_blocks(false);
}

/* Every set is one switch away: a single cycling mode entry charged two
 * switches to reach digits and symbols from lowercase, and digits are most of
 * what a passphrase mixes in. */
static void test_every_set_is_one_switch_away(void)
{
    printf("== each character set is one switch from any other\n");

    static const char *names[] = { "lower", "upper", "symbol" };
    static const char wanted[3][2] = {
        { TEXT_ENTRY_MODE_CAPS, TEXT_ENTRY_MODE_NUM },
        { TEXT_ENTRY_MODE_ABC,  TEXT_ENTRY_MODE_NUM },
        { TEXT_ENTRY_MODE_ABC,  TEXT_ENTRY_MODE_CAPS },
    };

    for (int s = 0; s < 3; s++) {
        TextEntry e;
        text_entry_reset(&e);
        e.set = (TextCharSet)s;

        for (int k = 0; k < 2; k++) {
            bool found = false;
            for (int i = 0; i < text_entry_option_count(&e); i++) {
                if (text_entry_option_at(&e, i) == wanted[s][k]) { found = true; break; }
            }
            CHECK(found, "%s does not offer mode 0x%02x directly",
                  names[s], (unsigned char)wanted[s][k]);
        }

        /* And the set the user is already in is not offered back to them. */
        char inert = (s == 0) ? TEXT_ENTRY_MODE_ABC
                   : (s == 1) ? TEXT_ENTRY_MODE_CAPS : TEXT_ENTRY_MODE_NUM;
        for (int i = 0; i < text_entry_option_count(&e); i++) {
            CHECK(text_entry_option_at(&e, i) != inert,
                  "%s offers a switch to itself at %d", names[s], i);
        }
    }
}

/* The screen shows three entries around the highlight. At the block level
 * those have to be blocks - showing one letter while a press moves six is how
 * a user ends up somewhere they did not aim for. */
static void test_block_labels_are_ranges(void)
{
    printf("== the selector labels blocks as ranges\n");

    text_entry_set_blocks(true);

    TextEntry e;
    text_entry_reset(&e);

    char here[12], next[12];
    text_entry_label_offset(&e, 0, here, sizeof(here));
    text_entry_label_offset(&e, 1, next, sizeof(next));
    CHECK(strcmp(here, "a-f") == 0, "first block is labelled \"%s\"", here);
    CHECK(strcmp(next, "g-l") == 0, "second block is labelled \"%s\"", next);
    CHECK(strcmp(here, next) != 0, "neighbouring blocks share a label");

    /* Inside the block the labels are single options again. */
    text_entry_accept(&e);
    text_entry_label_offset(&e, 0, here, sizeof(here));
    CHECK(strcmp(here, "a") == 0, "inside the block the highlight is \"%s\"", here);

    text_entry_set_blocks(false);

    /* With blocks off there is no block level to label. */
    text_entry_reset(&e);
    CHECK(!text_entry_on_group(&e), "flat selector reports a block level");
    text_entry_label_offset(&e, 0, here, sizeof(here));
    CHECK(strcmp(here, "a") == 0, "flat highlight is \"%s\"", here);
}

static void test_mixed_passphrase(void)
{
    printf("== a realistic mixed passphrase round-trips\n");

    const char *target = "Correct-Horse 42!";

    for (int blocks = 0; blocks < 2; blocks++) {
        text_entry_set_blocks(blocks != 0);

        TextEntry e;
        text_entry_reset(&e);

        int presses = 0;
        type_string(&e, target, &presses);

        CHECK(strcmp(e.text, target) == 0, "typed \"%s\", got \"%s\"", target, e.text);
        printf("  %-7s %zu characters in %d presses (%.1f per character)\n",
               blocks ? "blocks" : "simple", strlen(target), presses,
               (double)presses / (double)strlen(target));
    }

    text_entry_set_blocks(false);
}

/* T60. What a passphrase costs to type, measured rather than asserted.
 *
 * Every printable ASCII character, typed from a freshly reset selector, counted
 * in real button presses. The fresh reset is deliberate: it charges each
 * character the set switch it needs, which is exactly what a user pays when
 * their passphrase mixes cases and symbols.
 *
 * This is a security number, not an ergonomics one. Entry cost is what pushes
 * people towards a short guessable passphrase, or towards not using one at all
 * - and a passphrase is the only thing that makes a stolen device plus a stolen
 * seed backup insufficient. */
static void measure_charset(bool blocks, int worst_budget, double avg_budget)
{
    text_entry_set_blocks(blocks);

    int worst = 0, total = 0, n = 0;
    char worst_char = '?';

    for (int c = 0x20; c < 0x7f; c++) {
        TextEntry e;
        text_entry_reset(&e);

        int presses = 0;
        if (!type_char(&e, (char)c, &presses)) {
            CHECK(false, "'%c' (0x%02x) is not reachable", c, c);
            continue;
        }
        CHECK(e.length == 1 && e.text[0] == (char)c,
              "typing 0x%02x produced \"%s\"", c, e.text);

        total += presses;
        n++;
        if (presses > worst) {
            worst = presses;
            worst_char = (char)c;
        }
    }

    double average = (n > 0) ? (double)total / (double)n : 0.0;
    printf("  %-7s worst %d presses ('%c'), average %.2f per character\n",
           blocks ? "blocks" : "simple", worst, worst_char, average);

    CHECK(worst <= worst_budget,
          "%s: worst case %d presses ('%c') exceeds the %d-press budget",
          blocks ? "blocks" : "simple", worst, worst_char, worst_budget);
    CHECK(average <= avg_budget,
          "%s: average %.2f presses exceeds the %.1f-press budget",
          blocks ? "blocks" : "simple", average, avg_budget);
}

static void test_press_budget(void)
{
    printf("== presses per character stay inside budget (T60)\n");

    /* Ceilings, not targets: one press above what the selector achieves today,
     * so a regression trips them while ordinary refactoring does not.
     *
     * Before T60 this was 34 worst and 17.13 average with no block level at
     * all, and "Correct-Horse 42!" cost 231 presses. Both selectors ship, so
     * both are pinned - "simple" is the default and the one a user who never
     * opens Settings gets. */
    measure_charset(false, 29, 14.6);
    measure_charset(true,  15,  9.3);

    /* Leave the default as the rest of the suite expects to find it. */
    text_entry_set_blocks(false);
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
    test_press_budget();
    test_blocks_navigate_without_typing();
    test_every_set_is_one_switch_away();
    test_block_labels_are_ranges();
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
