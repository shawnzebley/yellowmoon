#ifndef YELLOWMOON_BRIDGE_H
#define YELLOWMOON_BRIDGE_H
#include <stddef.h>
#include <stdint.h>

int32_t ym_mobile_render(const char *data, const char *input, const char *work,
                        int32_t neutral, double exposure, uint32_t long_edge,
                        char *error, size_t capacity);
#endif
