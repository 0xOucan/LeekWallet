# Host-native test harness for LeekWallet.
# Compiles firmware logic for the build machine so defects can be reproduced
# without an ESP32 attached. See README.md in this directory.

CC      ?= gcc
CRYPTO  := ../components/trezor-crypto
CFLAGS  := -O1 -g -Wall -Wextra -Wno-unused-parameter \
           -I$(CRYPTO) -I../src -I. -Ishim \
           -DUSE_BIP39_CACHE=0 -DUSE_BIP32_CACHE=0 -DUSE_ETHEREUM=1 -DUSE_KECCAK=1
BUILD   := build

CRYPTO_SRC := $(CRYPTO)/bip39.c $(CRYPTO)/bip39_english.c $(CRYPTO)/sha2.c \
              $(CRYPTO)/pbkdf2.c $(CRYPTO)/hmac.c $(CRYPTO)/memzero.c $(CRYPTO)/rand.c

TESTS := test_mnemonic_entry test_pin test_passphrase test_entropy

all: $(addprefix $(BUILD)/,$(TESTS))

$(BUILD)/test_mnemonic_entry: test_mnemonic_entry.c host_stubs.c ../src/mnemonic-entry.c $(CRYPTO_SRC) | $(BUILD)
	$(CC) $(CFLAGS) -o $@ $^

$(BUILD)/test_entropy: test_entropy.c ../src/entropy.c \
                       $(CRYPTO)/sha2.c $(CRYPTO)/memzero.c | $(BUILD)
	$(CC) $(CFLAGS) -DLEEK_HOST_TEST -o $@ $^

$(BUILD)/test_passphrase: test_passphrase.c host_stubs.c $(CRYPTO_SRC) | $(BUILD)
	$(CC) $(CFLAGS) -o $@ $^

$(BUILD)/test_pin: test_pin.c esp_stubs.c ../src/pin.c \
                   $(CRYPTO)/sha2.c $(CRYPTO)/memzero.c | $(BUILD)
	$(CC) $(CFLAGS) -DLEEK_HOST_TEST -o $@ $^

$(BUILD):
	mkdir -p $(BUILD)

test: all
	@fail=0; for t in $(TESTS); do \
	  echo "== $$t"; ./$(BUILD)/$$t || fail=1; \
	done; exit $$fail

clean:
	rm -rf $(BUILD)

.PHONY: all test clean
