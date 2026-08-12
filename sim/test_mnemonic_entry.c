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
        while (e->option_index != found) {
            mnemonic_entry_scroll(e, 1);
            presses++;
        }

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

static void test_dead_end_letters_hidden(void)
{
    printf("== selector never offers a dead-end letter\n");

    MnemonicEntry e;
    mnemonic_entry_reset(&e, 12);

    /* "zo" leads only to "zone"/"zoo", so after "zo" the only letters that can
     * appear are 'n' and 'o'. */
    for (const char *p = "zo"; *p; p++) {
        int idx = -1;
        for (int i = 0; i < e.option_count; i++) if (e.options[i] == *p) idx = i;
        CHECK(idx >= 0, "letter '%c' not offered", *p);
        if (idx < 0) return;
        e.option_index = idx;
        mnemonic_entry_accept(&e);
    }

    for (int i = 0; i < e.option_count; i++) {
        char c = e.options[i];
        CHECK(c == 'n' || c == 'o' || c == MNEMONIC_ENTRY_COMMIT,
              "after \"zo\", unexpected option '%c'", c);
    }
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
    test_prefix_words();
    test_dead_end_letters_hidden();
    test_full_phrase_roundtrip();
    test_backspace();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
