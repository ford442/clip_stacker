#include "video_stabilize.h"
#include "stab_math.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <new>
#include <vector>

namespace {

// --- Tunables ---------------------------------------------------------------
// Sized for the ~360-480 px analysis frames stabilizePipeline.ts feeds in, not
// for full-resolution video: the caller downscales before pushing.
constexpr int kMaxPoints = 220;
constexpr int kPyramidLevels = 3;
constexpr int kWindowHalf = 4;       // 9x9 Lucas-Kanade window
constexpr int kLkIterations = 8;
constexpr float kMinCornerDistance = 10.f;
constexpr float kCornerQuality = 0.01f;
constexpr int kRansacIterations = 160;
constexpr float kRansacThreshold = 2.0f;   // pixels
constexpr int kMinTrackedPoints = 8;
constexpr float kMaxSmoothRadius = 120.f;

struct Image {
  std::vector<float> data;
  int width = 0;
  int height = 0;
};

/** Bilinear sample with edge clamping. */
float sampleBilinear(const Image& img, float x, float y) {
  if (img.width <= 0 || img.height <= 0) return 0.f;
  x = clampf(x, 0.f, static_cast<float>(img.width - 1));
  y = clampf(y, 0.f, static_cast<float>(img.height - 1));
  const int x0 = static_cast<int>(x);
  const int y0 = static_cast<int>(y);
  const int x1 = std::min(x0 + 1, img.width - 1);
  const int y1 = std::min(y0 + 1, img.height - 1);
  const float fx = x - static_cast<float>(x0);
  const float fy = y - static_cast<float>(y0);
  const float* d = img.data.data();
  const float v00 = d[y0 * img.width + x0];
  const float v10 = d[y0 * img.width + x1];
  const float v01 = d[y1 * img.width + x0];
  const float v11 = d[y1 * img.width + x1];
  return (v00 * (1.f - fx) + v10 * fx) * (1.f - fy) +
         (v01 * (1.f - fx) + v11 * fx) * fy;
}

/** Half-resolution copy with a 2x2 box filter (cheap, adequate as an LK pyramid). */
Image downsampleHalf(const Image& src) {
  Image out;
  out.width = std::max(1, src.width / 2);
  out.height = std::max(1, src.height / 2);
  out.data.assign(static_cast<size_t>(out.width) * static_cast<size_t>(out.height), 0.f);
  for (int y = 0; y < out.height; ++y) {
    const int sy0 = std::min(y * 2, src.height - 1);
    const int sy1 = std::min(y * 2 + 1, src.height - 1);
    for (int x = 0; x < out.width; ++x) {
      const int sx0 = std::min(x * 2, src.width - 1);
      const int sx1 = std::min(x * 2 + 1, src.width - 1);
      const float sum = src.data[sy0 * src.width + sx0] + src.data[sy0 * src.width + sx1] +
                        src.data[sy1 * src.width + sx0] + src.data[sy1 * src.width + sx1];
      out.data[y * out.width + x] = sum * 0.25f;
    }
  }
  return out;
}

using Pyramid = std::vector<Image>;

Pyramid buildPyramid(const Image& base) {
  Pyramid pyr;
  pyr.reserve(kPyramidLevels);
  pyr.push_back(base);
  for (int i = 1; i < kPyramidLevels; ++i) {
    const Image& prev = pyr.back();
    if (prev.width < 16 || prev.height < 16) break;
    pyr.push_back(downsampleHalf(prev));
  }
  return pyr;
}

// --- 1. Shi-Tomasi corner detection ----------------------------------------

struct Candidate {
  float score;
  int x;
  int y;
};

/**
 * Shi-Tomasi corners: the smaller eigenvalue of the windowed structure tensor,
 * thresholded relative to the frame's best corner, then thinned so no two kept
 * points sit within kMinCornerDistance of each other (spatial spread matters
 * more for a global motion fit than raw corner strength).
 */
std::vector<Point> detectCorners(const Image& img, int maxPoints) {
  std::vector<Point> corners;
  const int w = img.width;
  const int h = img.height;
  const int margin = kWindowHalf + 2;
  if (w <= 2 * margin || h <= 2 * margin) return corners;

  std::vector<float> minEig(static_cast<size_t>(w) * static_cast<size_t>(h), 0.f);
  float maxEig = 0.f;

  for (int y = margin; y < h - margin; ++y) {
    for (int x = margin; x < w - margin; ++x) {
      float sxx = 0.f, syy = 0.f, sxy = 0.f;
      for (int wy = -1; wy <= 1; ++wy) {
        for (int wx = -1; wx <= 1; ++wx) {
          const int px = x + wx;
          const int py = y + wy;
          const float ix =
              (img.data[py * w + px + 1] - img.data[py * w + px - 1]) * 0.5f;
          const float iy =
              (img.data[(py + 1) * w + px] - img.data[(py - 1) * w + px]) * 0.5f;
          sxx += ix * ix;
          syy += iy * iy;
          sxy += ix * iy;
        }
      }
      const float half = (sxx + syy) * 0.5f;
      const float diff = (sxx - syy) * 0.5f;
      const float root = std::sqrt(diff * diff + sxy * sxy);
      const float eig = half - root;
      minEig[static_cast<size_t>(y) * static_cast<size_t>(w) + static_cast<size_t>(x)] = eig;
      if (eig > maxEig) maxEig = eig;
    }
  }
  if (maxEig <= 0.f) return corners;

  const float threshold = maxEig * kCornerQuality;
  std::vector<Candidate> candidates;
  candidates.reserve(1024);
  for (int y = margin; y < h - margin; ++y) {
    for (int x = margin; x < w - margin; ++x) {
      const float eig = minEig[static_cast<size_t>(y) * static_cast<size_t>(w) + static_cast<size_t>(x)];
      if (eig < threshold) continue;
      // 3x3 non-maximum suppression before the (more expensive) distance pass.
      bool peak = true;
      for (int wy = -1; wy <= 1 && peak; ++wy) {
        for (int wx = -1; wx <= 1; ++wx) {
          if (wx == 0 && wy == 0) continue;
          if (minEig[static_cast<size_t>(y + wy) * static_cast<size_t>(w) +
                     static_cast<size_t>(x + wx)] > eig) {
            peak = false;
            break;
          }
        }
      }
      if (peak) candidates.push_back({eig, x, y});
    }
  }

  std::sort(candidates.begin(), candidates.end(),
            [](const Candidate& a, const Candidate& b) { return a.score > b.score; });

  const float minDistSq = kMinCornerDistance * kMinCornerDistance;
  for (const Candidate& c : candidates) {
    if (static_cast<int>(corners.size()) >= maxPoints) break;
    bool tooClose = false;
    for (const Point& kept : corners) {
      const float dx = kept.x - static_cast<float>(c.x);
      const float dy = kept.y - static_cast<float>(c.y);
      if (dx * dx + dy * dy < minDistSq) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) {
      corners.push_back({static_cast<float>(c.x), static_cast<float>(c.y)});
    }
  }
  return corners;
}

// --- 2. Pyramidal Lucas-Kanade tracking ------------------------------------

/**
 * Track one point from `prev` into `curr`, coarse level first so the search
 * survives motion wider than the 9x9 window. Returns false when the window is
 * degenerate (no gradient to solve against) or the flow leaves the frame.
 */
bool trackPoint(const Pyramid& prev, const Pyramid& curr, Point p, Point* out) {
  const int levels = static_cast<int>(std::min(prev.size(), curr.size()));
  if (levels == 0) return false;

  float gx = 0.f;
  float gy = 0.f;

  for (int level = levels - 1; level >= 0; --level) {
    const Image& ip = prev[static_cast<size_t>(level)];
    const Image& ic = curr[static_cast<size_t>(level)];
    const float scale = 1.f / static_cast<float>(1 << level);
    const float px = p.x * scale;
    const float py = p.y * scale;

    // Structure tensor of the previous frame's window (constant across iterations).
    float sxx = 0.f, syy = 0.f, sxy = 0.f;
    std::vector<float> gradX;
    std::vector<float> gradY;
    const int side = kWindowHalf * 2 + 1;
    gradX.reserve(static_cast<size_t>(side) * static_cast<size_t>(side));
    gradY.reserve(static_cast<size_t>(side) * static_cast<size_t>(side));
    for (int wy = -kWindowHalf; wy <= kWindowHalf; ++wy) {
      for (int wx = -kWindowHalf; wx <= kWindowHalf; ++wx) {
        const float sx = px + static_cast<float>(wx);
        const float sy = py + static_cast<float>(wy);
        const float ix = (sampleBilinear(ip, sx + 1.f, sy) - sampleBilinear(ip, sx - 1.f, sy)) * 0.5f;
        const float iy = (sampleBilinear(ip, sx, sy + 1.f) - sampleBilinear(ip, sx, sy - 1.f)) * 0.5f;
        gradX.push_back(ix);
        gradY.push_back(iy);
        sxx += ix * ix;
        syy += iy * iy;
        sxy += ix * iy;
      }
    }

    const float det = sxx * syy - sxy * sxy;
    if (std::fabs(det) < 1e-6f) return false;
    const float invDet = 1.f / det;

    for (int iter = 0; iter < kLkIterations; ++iter) {
      float bx = 0.f;
      float by = 0.f;
      size_t k = 0;
      for (int wy = -kWindowHalf; wy <= kWindowHalf; ++wy) {
        for (int wx = -kWindowHalf; wx <= kWindowHalf; ++wx, ++k) {
          const float sx = px + static_cast<float>(wx);
          const float sy = py + static_cast<float>(wy);
          const float diff = sampleBilinear(ip, sx, sy) -
                             sampleBilinear(ic, sx + gx, sy + gy);
          bx += diff * gradX[k];
          by += diff * gradY[k];
        }
      }
      const float vx = (syy * bx - sxy * by) * invDet;
      const float vy = (sxx * by - sxy * bx) * invDet;
      gx += vx;
      gy += vy;
      if (vx * vx + vy * vy < 1e-4f) break;
    }

    if (level > 0) {
      gx *= 2.f;
      gy *= 2.f;
    }
  }

  const Image& full = curr[0];
  const float nx = p.x + gx;
  const float ny = p.y + gy;
  if (nx < 0.f || ny < 0.f || nx > static_cast<float>(full.width - 1) ||
      ny > static_cast<float>(full.height - 1)) {
    return false;
  }
  out->x = nx;
  out->y = ny;
  return true;
}

// --- 3. Similarity fit with RANSAC -----------------------------------------

/**
 * RANSAC over 2-point similarity hypotheses, then a least-squares refit on the
 * best consensus set.
 *
 * A similarity (rotate + uniform scale + translate) rather than a full 6-DOF
 * affine on purpose: shear and anisotropic scale are never real handheld camera
 * motion, so leaving them free only lets tracking noise into the correction,
 * where it shows up as a wobbling picture.
 */
bool estimateRigidTransform(
    const std::vector<Point>& src,
    const std::vector<Point>& dst,
    unsigned int* rngState,
    ComplexZ* zOut,
    Point* tOut) {
  const size_t n = src.size();
  if (n < 2) return false;

  const float thresholdSq = kRansacThreshold * kRansacThreshold;
  std::vector<int> best;
  std::vector<int> pair(2);
  std::vector<int> inliers;
  inliers.reserve(n);

  auto nextRand = [rngState]() {
    // xorshift32 — deterministic across builds so results are reproducible.
    unsigned int x = *rngState;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *rngState = x;
    return x;
  };

  for (int iter = 0; iter < kRansacIterations; ++iter) {
    const int i0 = static_cast<int>(nextRand() % n);
    int i1 = static_cast<int>(nextRand() % n);
    if (i1 == i0) i1 = static_cast<int>((static_cast<size_t>(i0) + 1) % n);

    const float dx = src[static_cast<size_t>(i1)].x - src[static_cast<size_t>(i0)].x;
    const float dy = src[static_cast<size_t>(i1)].y - src[static_cast<size_t>(i0)].y;
    // Near-coincident pairs give a wildly over-scaled hypothesis.
    if (dx * dx + dy * dy < 4.f) continue;

    pair[0] = i0;
    pair[1] = i1;
    ComplexZ z;
    Point t;
    if (!fitSimilarity(src, dst, pair, &z, &t)) continue;

    inliers.clear();
    for (size_t i = 0; i < n; ++i) {
      Point mapped;
      applyZ(z, t, src[i], &mapped);
      const float ex = mapped.x - dst[i].x;
      const float ey = mapped.y - dst[i].y;
      if (ex * ex + ey * ey <= thresholdSq) inliers.push_back(static_cast<int>(i));
    }
    if (inliers.size() > best.size()) best = inliers;
  }

  if (best.size() < static_cast<size_t>(kMinTrackedPoints)) return false;
  return fitSimilarity(src, dst, best, zOut, tOut);
}

// --- Handle -----------------------------------------------------------------

}  // namespace

struct StabHandle {
  int width = 0;
  int height = 0;
  int smoothRadius = 30;
  bool finalized = false;
  unsigned int rngState = 0x9e3779b9u;

  Pyramid prevPyramid;
  bool hasPrev = false;

  /** Frame-to-frame motion; entry 0 is the identity for the first frame. */
  std::vector<Similarity> motion;
  std::vector<Correction> corrections;
  float zoom = 1.f;
  float maxCorrection = 0.f;
};

extern "C" {

StabHandle* stab_create(int width, int height, int smooth_radius) {
  if (width <= 0 || height <= 0) return nullptr;
  StabHandle* h = new (std::nothrow) StabHandle();
  if (!h) return nullptr;
  h->width = width;
  h->height = height;
  h->smoothRadius = static_cast<int>(
      clampf(static_cast<float>(smooth_radius), 1.f, kMaxSmoothRadius));
  return h;
}

int stab_push_frame(StabHandle* handle, const uint8_t* gray) {
  if (!handle || !gray || handle->finalized) return -1;

  Image img;
  img.width = handle->width;
  img.height = handle->height;
  const size_t count = static_cast<size_t>(img.width) * static_cast<size_t>(img.height);
  img.data.resize(count);
  for (size_t i = 0; i < count; ++i) {
    img.data[i] = static_cast<float>(gray[i]);
  }

  Pyramid pyr = buildPyramid(img);
  const int index = static_cast<int>(handle->motion.size());

  if (!handle->hasPrev) {
    handle->motion.push_back(Similarity{0.f, 0.f, 0.f, 0.f, true});
  } else {
    Similarity motion;
    const std::vector<Point> corners = detectCorners(handle->prevPyramid[0], kMaxPoints);

    std::vector<Point> src;
    std::vector<Point> dst;
    src.reserve(corners.size());
    dst.reserve(corners.size());
    for (const Point& p : corners) {
      Point tracked;
      if (trackPoint(handle->prevPyramid, pyr, p, &tracked)) {
        src.push_back(p);
        dst.push_back(tracked);
      }
    }

    ComplexZ z;
    Point t;
    if (src.size() >= static_cast<size_t>(kMinTrackedPoints) &&
        estimateRigidTransform(src, dst, &handle->rngState, &z, &t)) {
      // Re-express p' = z*p + t about the frame centre so dx/dy are a pure
      // centre shift and stay independent of the rotation term.
      const float cx = static_cast<float>(handle->width) * 0.5f;
      const float cy = static_cast<float>(handle->height) * 0.5f;
      Point centre{cx, cy};
      Point mappedCentre;
      applyZ(z, t, centre, &mappedCentre);
      motion.dx = mappedCentre.x - cx;
      motion.dy = mappedCentre.y - cy;
      motion.dtheta = std::atan2(z.im, z.re);
      const float mag = std::sqrt(z.re * z.re + z.im * z.im);
      motion.dlogs = mag > 1e-6f ? std::log(mag) : 0.f;
      motion.valid = true;
    } else {
      // Too few tracks (motion blur, a cut, a flat wall): assume the camera
      // held still rather than inventing a correction from noise.
      motion.valid = false;
    }
    handle->motion.push_back(motion);
  }

  handle->prevPyramid = std::move(pyr);
  handle->hasPrev = true;
  return index;
}

int stab_frame_count(const StabHandle* handle) {
  if (!handle) return 0;
  return static_cast<int>(handle->motion.size());
}

int stab_finalize(StabHandle* handle) {
  if (!handle) return 1;
  if (handle->finalized) return 0;
  const size_t n = handle->motion.size();
  if (n == 0) return 1;

  float zoom = 1.f;
  float maxOffset = 0.f;
  std::vector<Correction> raw =
      buildCorrections(handle->motion, handle->width, handle->height,
                       handle->smoothRadius, &zoom, &maxOffset);

  handle->corrections = std::move(raw);
  handle->zoom = zoom;
  handle->maxCorrection = maxOffset;
  handle->finalized = true;
  return 0;
}

void stab_get_matrix(const StabHandle* handle, int frame_idx, float* out) {
  if (!out) return;
  if (!handle || !handle->finalized || frame_idx < 0 ||
      frame_idx >= static_cast<int>(handle->corrections.size())) {
    identityMatrix(out);
    return;
  }
  const Correction& c = handle->corrections[static_cast<size_t>(frame_idx)];
  out[0] = c.a; out[1] = c.b; out[2] = c.tx;
  out[3] = c.c; out[4] = c.d; out[5] = c.ty;
}

float stab_get_zoom(const StabHandle* handle) {
  return handle ? handle->zoom : 1.f;
}

float stab_get_max_correction(const StabHandle* handle) {
  return handle ? handle->maxCorrection : 0.f;
}

void stab_apply_warp(
    const StabHandle* handle,
    const uint8_t* rgba_in,
    uint8_t* rgba_out,
    int frame_idx) {
  if (!handle || !rgba_in || !rgba_out) return;
  const int w = handle->width;
  const int h = handle->height;
  const size_t bytes = static_cast<size_t>(w) * static_cast<size_t>(h) * 4u;

  float m[STAB_MATRIX_FLOATS];
  stab_get_matrix(handle, frame_idx, m);
  if (m[0] == 1.f && m[1] == 0.f && m[2] == 0.f &&
      m[3] == 0.f && m[4] == 1.f && m[5] == 0.f) {
    std::memcpy(rgba_out, rgba_in, bytes);
    return;
  }

  for (int y = 0; y < h; ++y) {
    const float v = (static_cast<float>(y) + 0.5f) / static_cast<float>(h) - 0.5f;
    for (int x = 0; x < w; ++x) {
      const float u = (static_cast<float>(x) + 0.5f) / static_cast<float>(w) - 0.5f;
      const float su = m[0] * u + m[1] * v + 0.5f + m[2];
      const float sv = m[3] * u + m[4] * v + 0.5f + m[5];
      const float sx = clampf(su * static_cast<float>(w) - 0.5f, 0.f, static_cast<float>(w - 1));
      const float sy = clampf(sv * static_cast<float>(h) - 0.5f, 0.f, static_cast<float>(h - 1));

      const int x0 = static_cast<int>(sx);
      const int y0 = static_cast<int>(sy);
      const int x1 = std::min(x0 + 1, w - 1);
      const int y1 = std::min(y0 + 1, h - 1);
      const float fx = sx - static_cast<float>(x0);
      const float fy = sy - static_cast<float>(y0);

      const size_t i00 = (static_cast<size_t>(y0) * static_cast<size_t>(w) + static_cast<size_t>(x0)) * 4u;
      const size_t i10 = (static_cast<size_t>(y0) * static_cast<size_t>(w) + static_cast<size_t>(x1)) * 4u;
      const size_t i01 = (static_cast<size_t>(y1) * static_cast<size_t>(w) + static_cast<size_t>(x0)) * 4u;
      const size_t i11 = (static_cast<size_t>(y1) * static_cast<size_t>(w) + static_cast<size_t>(x1)) * 4u;
      const size_t o = (static_cast<size_t>(y) * static_cast<size_t>(w) + static_cast<size_t>(x)) * 4u;

      for (int ch = 0; ch < 4; ++ch) {
        const float top = static_cast<float>(rgba_in[i00 + static_cast<size_t>(ch)]) * (1.f - fx) +
                          static_cast<float>(rgba_in[i10 + static_cast<size_t>(ch)]) * fx;
        const float bot = static_cast<float>(rgba_in[i01 + static_cast<size_t>(ch)]) * (1.f - fx) +
                          static_cast<float>(rgba_in[i11 + static_cast<size_t>(ch)]) * fx;
        const float val = top * (1.f - fy) + bot * fy;
        rgba_out[o + static_cast<size_t>(ch)] =
            static_cast<uint8_t>(clampf(val + 0.5f, 0.f, 255.f));
      }
    }
  }
}

void stab_destroy(StabHandle* handle) {
  delete handle;
}

}  // extern "C"
