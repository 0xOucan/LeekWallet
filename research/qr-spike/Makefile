QUIRC := quirc/lib
CFLAGS ?= -O2 -Wall -I$(QUIRC)
SRC := bench.c $(QUIRC)/quirc.c $(QUIRC)/identify.c $(QUIRC)/decode.c $(QUIRC)/version_db.c

bench: $(SRC) | $(QUIRC)
	$(CC) $(CFLAGS) -o $@ $(SRC) -lm

$(QUIRC):
	./fetch-quirc.sh

frames.gray: gen-frames.py
	python3 gen-frames.py -o $@

run: bench frames.gray
	./bench frames.gray 20

clean:
	rm -f bench frames.gray

.PHONY: run clean
