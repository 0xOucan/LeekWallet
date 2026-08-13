/**
 * Host-native tests for src/mnemonic-entry.c
 *
 * The headline test drives every one of the 2048 BIP39 words through the real
 * entry state machine, keystroke by keystroke, and asserts the device commits
 * the word the user meant. This is the regression guard for AUDIT.md S3.
 */

#include <stdio.h>
#include <string.h>

#include "bip39.h"
#include "mnemonic-entry.h"

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: ");                          \
        printf(__VA_ARGS__);                         \
        printf("\n");                                \
        failures++;                                  \
    }                                                \
} while (0)

/* Walk the selector onto option `to` and count the presses it takes.
 *
 * Models a real user: scroll whichever way is shorter (the ring wraps, so a
 * forward-only model would over-charge every option past the halfway mark),
 * and when the list is split into blocks, scroll to the block, open it, then
 * scroll inside it. */
static int scroll_to(MnemonicEntry *e, int to)
{
    int presses = 0;

    if (mnemonic_entry_on_group(e)) {
        int g = e->group_size;
        int blocks = (e->option_count + g - 1) / g;
        int want = to / g;
        while (e->option_index / g != want) {
            int forward = ((want - e->option_index / g) % blocks + blocks) % blocks;
            mnemonic_entry_scroll(e, (forward * 2 <= blocks) ? 1 : -1);
            presses++;
        }
        mnemonic_entry_accept(e);   /* open the block */
        presses++;
    }

    int start = 0, span = e->option_count;
    if (e->group_size > 0) {
        start = (e->option_index / e->group_size) * e->group_size;
        span = e->option_count - start;
        if (span > e->group_size) span = e->group_size;
    }

    while (e->option_index != to) {
        int forward = ((to - e->option_index) % span + span) % span;
        mnemonic_entry_scroll(e, (forward * 2 <= span) ? 1 : -1);
        presses++;
    }
    return presses;
}

/**
 * Type `target` on the 4-button UI and return what actually got committed.
 *
 * Models a user who scrolls the selector to the letter they want, and picks
 * COMMIT once the full word is typed and no auto-commit has fired.
 */
static const char *type_word(MnemonicEntry *e, const char *target, int *keystrokes)
{
    /* Resume from whatever is already in the prefix (e.g. after a backspace
     * reopened the previous word) rather than assuming a blank slate. */
    if (strncmp(target, e->prefix, (size_t)e->prefix_len) != 0) {
        return NULL;
    }
    size_t next = (size_t)e->prefix_len;
    int presses = 0;
    int before = e->word_count;

    while (presses < 200) {
        char want;

        /* Word phase: pick the word itself rather than typing more letters. */
        if (e->word_mode) {
            int found = -1;
            int here = e->option_index;
            for (int i = 0; i < e->option_count; i++) {
                e->option_index = i;
                const char *w = mnemonic_entry_selected_word(e);
                if (w && strcmp(w, target) == 0) { found = i; break; }
            }
            e->option_index = here;
            if (found < 0) {
                return NULL;  /* the word we want is not on offer - dead end */
            }
            presses += scroll_to(e, found);
            mnemonic_entry_accept(e);
            presses++;
            if (e->word_count > before) {
                if (keystrokes) *keystrokes = presses;
                return e->words[before];
            }
            return NULL;
        }

        if (next < strlen(target)) {
            want = target[next];
        } else {
            /* Whole word typed and still not committed: use COMMIT. */
            want = MNEMONIC_ENTRY_COMMIT;
        }

        /* Scroll to the option we want. */
        int found = -1;
        for (int i = 0; i < e->option_count; i++) {
            if (e->options[i] == want) { found = i; break; }
        }
        if (found < 0) {
            return NULL;  /* the letter we need is not offered - dead end */
        }
        presses += scroll_to(e, found);

        if (want != MNEMONIC_ENTRY_COMMIT) {
            next++;
        }

        MnemonicEntryResult r = mnemonic_entry_accept(e);
        presses++;

        if (e->word_count > before) {
            if (keystrokes) *keystrokes = presses;
            return e->words[before];
        }
        if (r == MNEMONIC_ENTRY_ALL_DONE) break;
    }

    return NULL;
}

static void test_every_word_reachable(void)
{
    printf("== every BIP39 word is enterable\n");

    int wrong = 0, stuck = 0, worst = 0;
    const char *worst_word = "";

    for (int i = 0; i < 2048; i++) {
        const char *word = mnemonic_get_word(i);

        MnemonicEntry e;
        mnemonic_entry_reset(&e, 12);

        int presses = 0;
        const char *got = type_word(&e, word, &presses);

        if (!got) {
            if (stuck < 5) printf("  STUCK: \"%s\" can never be committed\n", word);
            stuck++;
        } else if (strcmp(got, word) != 0) {
            if (wrong < 5) printf("  WRONG: typing \"%s\" commits \"%s\"\n", word, got);
            wrong++;
        } else if (presses > worst) {
            worst = presses;
            worst_word = word;
        }
    }

    CHECK(wrong == 0, "%d words commit the wrong word", wrong);
    CHECK(stuck == 0, "%d words can never be committed", stuck);
    printf("  worst case: %d button presses (\"%s\")\n", worst, worst_word);
}

/* T44. Entry cost is the thing people actually abandon, so it is measured
 * rather than eyeballed: every word, counted in button presses, with a ceiling
 * that fails the build if a future selector change makes typing slower again.
 *
 * The budgets sit one press above what the selector achieves today (19 worst,
 * 12.00 average, down from 38 and 19.80 before the block and word phases), so
 * a regression trips them while ordinary refactoring does not. */
#define WORST_CASE_BUDGET   20
#define AVERAGE_CASE_BUDGET 12.5

static void test_press_budget(void)
{
    printf("== presses per word stay inside budget (T44)\n");

    int worst = 0, total = 0;
    const char *worst_word = "";

    for (int i = 0; i < 2048; i++) {
        const char *word = mnemonic_get_word(i);

        MnemonicEntry e;
        mnemonic_entry_reset(&e, 12);

        int presses = 0;
        const char *got = type_word(&e, word, &presses);
        CHECK(got && strcmp(got, word) == 0, "\"%s\" is not typeable", word);
        if (!got) continue;

        total += presses;
        if (presses > worst) {
            worst = presses;
            worst_word = word;
        }
    }

    double average = (double)total / 2048.0;
    printf("  worst %d presses (\"%s\"), average %.2f\n", worst, worst_word, average);

    CHECK(worst <= WORST_CASE_BUDGET,
          "worst case %d presses (\"%s\") exceeds the %d-press budget",
          worst, worst_word, WORST_CASE_BUDGET);
    CHECK(average <= AVERAGE_CASE_BUDGET,
          "average %.2f presses exceeds the %.1f-press budget",
          average, AVERAGE_CASE_BUDGET);
}

/* The specific words S3 made unreachable: each is extended by a longer word. */
static void test_prefix_words(void)
{
    printf("== words that are prefixes of longer words\n");

    static const char *pairs[][2] = {
        {"add", "address"}, {"act", "actress"}, {"air", "airport"},
        {"all", "alley"},   {"can", "canyon"},  {"car", "carbon"},
        {"cat", "catalog"}, {"age", "agent"},   {"arm", "army"},
    };

    for (size_t i = 0; i < sizeof(pairs) / sizeof(pairs[0]); i++) {
        for (int which = 0; which < 2; which++) {
            const char *word = pairs[i][which];
            MnemonicEntry e;
            mnemonic_entry_reset(&e, 12);
            const char *got = type_word(&e, word, NULL);
            CHECK(got && strcmp(got, word) == 0,
                  "typed \"%s\", got \"%s\"", word, got ? got : "(nothing)");
        }
    }
}

/* How many BIP39 words start with `prefix`. */
static int matches_for(const char *prefix)
{
    int n = 0;
    for (int i = 0; i < 2048; i++) {
        if (strncmp(mnemonic_get_word(i), prefix, strlen(prefix)) == 0) n++;
    }
    return n;
}

/* Every option the selector shows must lead somewhere. The word phase made
 * this worth re-testing from scratch: a stale candidate list would offer a
 * word that does not match what the user typed, which is the same class of bug
 * as a dead-end letter and strictly worse in its consequences. */
static void test_no_dead_end_options(void)
{
    printf("== selector never offers a dead end\n");

    int bad = 0;

    for (int w = 0; w < 2048 && bad < 5; w++) {
        MnemonicEntry e;
        mnemonic_entry_reset(&e, 12);
        const char *target = mnemonic_get_word(w);

        /* Walk the states this word passes through. */
        for (size_t step = 0; step <= strlen(target); step++) {
            for (int i = 0; i < e.option_count && bad < 5; i++) {
                if (e.word_mode) {
                    e.option_index = i;
                    const char *cand = mnemonic_entry_selected_word(&e);
                    if (!cand || strncmp(cand, e.prefix, (size_t)e.prefix_len) != 0) {
                        printf("  candidate \"%s\" does not match prefix \"%s\"\n",
                               cand ? cand : "(null)", e.prefix);
                        bad++;
                    }
                    continue;
                }

                char c = e.options[i];
                if (c == MNEMONIC_ENTRY_COMMIT) {
                    if (mnemonic_find_word(e.prefix) < 0 && matches_for(e.prefix) != 1) {
                        printf("  OK offered on \"%s\", which is not a word\n", e.prefix);
                        bad++;
                    }
                    continue;
                }

                char probe[MNEMONIC_ENTRY_WORD_LEN + 1];
                snprintf(probe, sizeof(probe), "%s%c", e.prefix, c);
                if (matches_for(probe) == 0) {
                    printf("  dead-end option '%c' after \"%s\"\n", c, e.prefix);
                    bad++;
                }
            }
            e.option_index = 0;

            if (e.word_mode || step == strlen(target)) break;

            /* Advance one character the way the UI would. */
            int idx = -1;
            for (int i = 0; i < e.option_count; i++) {
                if (e.options[i] == target[step]) { idx = i; break; }
            }
            if (idx < 0) break;
            scroll_to(&e, idx);
            mnemonic_entry_accept(&e);
        }
    }

    CHECK(bad == 0, "%d dead-end options offered", bad);
}

static void test_full_phrase_roundtrip(void)
{
    printf("== full 12-word phrase round-trip\n");

    const char *phrase[] = {
        "address", "act", "zoo", "abandon", "canyon", "add",
        "airport", "army", "catalog", "age", "all", "about",
    };

    MnemonicEntry e;
    mnemonic_entry_reset(&e, 12);

    for (int i = 0; i < 12; i++) {
        const char *got = type_word(&e, phrase[i], NULL);
        CHECK(got && strcmp(got, phrase[i]) == 0,
              "word %d: wanted \"%s\", got \"%s\"", i + 1, phrase[i], got ? got : "(nothing)");
    }

    char out[300];
    mnemonic_entry_build(&e, out, sizeof(out));

    char expect[300] = {0};
    for (int i = 0; i < 12; i++) {
        if (i) strcat(expect, " ");
        strcat(expect, phrase[i]);
    }
    CHECK(strcmp(out, expect) == 0, "built \"%s\"", out);

    mnemonic_entry_clear(&e);
    CHECK(e.word_count == 0 && e.words[0][0] == '\0', "clear() left residue");
}

/* T3 / S8d. The entry logic always handled 24 words; the device had no way to
 * ask for them, so every 24-word backup was unimportable. This is the
 * round-trip the roadmap asks for, and it also pins down the boundary that
 * makes a wrong length dangerous: a 24-word phrase must NOT report itself
 * complete at word 12. If it did, the user would import a wallet built from
 * the first half of their backup and only discover it by finding no funds. */
static void test_24_word_roundtrip(void)
{
    printf("== full 24-word phrase round-trip (T3)\n");

    /* A real 24-word phrase: the all-zeros entropy vector from BIP39. */
    const char *phrase[24] = {
        "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
        "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
        "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
        "abandon", "abandon", "abandon", "abandon", "abandon", "art",
    };

    MnemonicEntry e;
    mnemonic_entry_reset(&e, 24);
    CHECK(e.target_words == 24, "reset clamped the target to %d", e.target_words);

    for (int i = 0; i < 24; i++) {
        const char *got = type_word(&e, phrase[i], NULL);
        CHECK(got && strcmp(got, phrase[i]) == 0,
              "word %d: wanted \"%s\", got \"%s\"", i + 1, phrase[i], got ? got : "(nothing)");

        /* The half-way point is the dangerous one. */
        if (i == 11) {
            CHECK(e.word_count == 12, "word 12 left a count of %d", e.word_count);
        }
    }

    CHECK(e.word_count == 24, "ended with %d words", e.word_count);

    char out[300];
    mnemonic_entry_build(&e, out, sizeof(out));

    char expect[300] = {0};
    for (int i = 0; i < 24; i++) {
        if (i) strcat(expect, " ");
        strcat(expect, phrase[i]);
    }
    CHECK(strcmp(out, expect) == 0, "built \"%s\"", out);

    mnemonic_entry_clear(&e);
    CHECK(e.word_count == 0 && e.words[0][0] == '\0', "clear() left residue");
    /* clear() keeps the target on purpose: the length is not a secret, and the
     * screen re-uses it when the user backs out of a word and starts again. */
    CHECK(e.target_words == 24, "clear() dropped the chosen length");
}

/* Anything that is not 12 or 24 is a caller mistake, and the safe reading is
 * the shorter phrase - never a longer one the user has not been asked for. */
static void test_target_is_clamped(void)
{
    printf("== an out-of-range target falls back to 12\n");
    MnemonicEntry e;

    mnemonic_entry_reset(&e, 18);
    CHECK(e.target_words == 12, "18 became %d", e.target_words);
    mnemonic_entry_reset(&e, 0);
    CHECK(e.target_words == 12, "0 became %d", e.target_words);
    mnemonic_entry_reset(&e, 25);
    CHECK(e.target_words == 12, "25 became %d", e.target_words);
}

static void test_backspace(void)
{
    printf("== backspace across word boundaries\n");

    MnemonicEntry e;
    mnemonic_entry_reset(&e, 12);

    CHECK(mnemonic_entry_back(&e) == false, "back() on empty state should signal exit");

    type_word(&e, "zoo", NULL);
    CHECK(e.word_count == 1, "expected 1 word committed, got %d", e.word_count);

    CHECK(mnemonic_entry_back(&e) == true, "back() into previous word failed");
    CHECK(e.word_count == 0, "word_count should drop to 0, got %d", e.word_count);

    /* The reopened word is editable and can be re-committed. */
    const char *got = type_word(&e, "zoo", NULL);
    CHECK(got && strcmp(got, "zoo") == 0, "re-entry after back() gave \"%s\"", got ? got : "(nothing)");
}

int main(void)
{
    test_every_word_reachable();
    test_press_budget();
    test_prefix_words();
    test_no_dead_end_options();
    test_full_phrase_roundtrip();
    test_24_word_roundtrip();
    test_target_is_clamped();
    test_backspace();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
