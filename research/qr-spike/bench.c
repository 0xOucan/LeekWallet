/* Decode-rate bench for the QR air gap.
 *
 * Runs the identical pipeline on the host, under QEMU and on real hardware:
 * feed a grayscale frame to quirc, identify, decode, repeat. It measures the
 * half we control. It does NOT measure camera capture, which no emulator on
 * this project provides (see README).
 *
 * Build: make            (host)
 *        make qemu       (xtensa, via ESP-IDF, see README)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "quirc.h"

#ifndef FRAME_W
#define FRAME_W 320
#endif
#ifndef FRAME_H
#define FRAME_H 240
#endif

static double now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}

int main(int argc, char **argv) {
    const char *path = argc > 1 ? argv[1] : "frames.gray";
    int reps = argc > 2 ? atoi(argv[2]) : 1;

    FILE *f = fopen(path, "rb");
    if (!f) { perror(path); return 1; }
    fseek(f, 0, SEEK_END);
    long total = ftell(f);
    fseek(f, 0, SEEK_SET);

    const long frame_bytes = (long)FRAME_W * FRAME_H;
    int frames = (int)(total / frame_bytes);
    if (frames < 1) { fprintf(stderr, "no whole frames in %s\n", path); return 1; }

    uint8_t *data = malloc(total);
    if (!data || fread(data, 1, total, f) != (size_t)total) {
        fprintf(stderr, "read failed\n"); return 1;
    }
    fclose(f);

    struct quirc *q = quirc_new();
    if (!q || quirc_resize(q, FRAME_W, FRAME_H) < 0) {
        fprintf(stderr, "quirc alloc failed (needs ~%ld KB)\n",
                (frame_bytes * 3) / 1024);
        return 1;
    }

    double t_total = 0, t_worst = 0;
    int decoded = 0, found = 0, attempts = 0;

    for (int r = 0; r < reps; r++) {
        for (int i = 0; i < frames; i++) {
            uint8_t *img = quirc_begin(q, NULL, NULL);
            memcpy(img, data + (long)i * frame_bytes, frame_bytes);

            double t0 = now_ms();
            quirc_end(q);
            int n = quirc_count(q);
            found += n;
            for (int j = 0; j < n; j++) {
                struct quirc_code code;
                struct quirc_data out;
                quirc_extract(q, j, &code);
                if (quirc_decode(&code, &out) == QUIRC_SUCCESS) decoded++;
            }
            double dt = now_ms() - t0;
            t_total += dt;
            if (dt > t_worst) t_worst = dt;
            attempts++;
        }
    }

    quirc_destroy(q);
    free(data);

    double mean = t_total / attempts;
    printf("frames        %d x %d reps = %d\n", frames, reps, attempts);
    printf("resolution    %dx%d grayscale\n", FRAME_W, FRAME_H);
    printf("located       %d\n", found);
    printf("decoded       %d  (%.1f%%)\n", decoded, 100.0 * decoded / attempts);
    printf("mean          %.2f ms/frame\n", mean);
    printf("worst         %.2f ms/frame\n", t_worst);
    printf("decode rate   %.1f frames/s (decode only, no capture)\n", 1000.0 / mean);
    return decoded == attempts ? 0 : 2;
}
