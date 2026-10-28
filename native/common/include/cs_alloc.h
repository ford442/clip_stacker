// Allocation helpers that report OOM instead of aborting.
//
// The WASM modules build with -fno-exceptions, so a failed `std::vector`
// allocation calls abort(): the module traps and is dead for the session.
// Emscripten's malloc returns null once ALLOW_MEMORY_GROWTH hits
// MAXIMUM_MEMORY, and `new (std::nothrow)` passes that through, so large or
// caller-sized buffers go through these helpers and surface `CS_ENOMEM`.
#pragma once

#include <cstddef>
#include <cstring>
#include <new>
#include <vector>

namespace cs {

/** Owning, non-copyable array allocated with nothrow new (zero-initialized). */
template <typename T>
class Buffer {
 public:
  Buffer() = default;
  Buffer(const Buffer&) = delete;
  Buffer& operator=(const Buffer&) = delete;
  Buffer(Buffer&& other) noexcept : data_(other.data_), size_(other.size_) {
    other.data_ = nullptr;
    other.size_ = 0;
  }
  Buffer& operator=(Buffer&& other) noexcept {
    if (this != &other) {
      delete[] data_;
      data_ = other.data_;
      size_ = other.size_;
      other.data_ = nullptr;
      other.size_ = 0;
    }
    return *this;
  }
  ~Buffer() { delete[] data_; }

  /** Replace the contents with `n` zeroed elements. False (and empty) on OOM. */
  bool allocate(std::size_t n) {
    delete[] data_;
    data_ = nullptr;
    size_ = 0;
    if (n == 0) return true;
    data_ = new (std::nothrow) T[n]();
    if (!data_) return false;
    size_ = n;
    return true;
  }

  /** Grow to at least `n` elements; contents are not preserved. */
  bool ensure(std::size_t n) { return n <= size_ || allocate(n); }

  T* data() { return data_; }
  const T* data() const { return data_; }
  std::size_t size() const { return size_; }
  T& operator[](std::size_t i) { return data_[i]; }
  const T& operator[](std::size_t i) const { return data_[i]; }

 private:
  T* data_ = nullptr;
  std::size_t size_ = 0;
};

/**
 * True when `bytes` can be allocated right now. The probe block is freed
 * before returning; in a single-threaded heap (every module except whisper)
 * the allocations that follow reuse it, so a passing probe sized to a call's
 * peak working set means the `std::vector`s inside that call will not abort.
 */
inline bool can_allocate(std::size_t bytes) {
  if (bytes == 0) return true;
  void* probe = ::operator new(bytes, std::nothrow);
  if (!probe) return false;
  ::operator delete(probe);
  return true;
}

/** `v.reserve(n)` that returns false instead of aborting on OOM. */
template <typename T>
bool try_reserve(std::vector<T>& v, std::size_t n) {
  if (n <= v.capacity()) return true;
  if (n > v.max_size() || !can_allocate(n * sizeof(T))) return false;
  v.reserve(n);
  return true;
}

/** `v.push_back(value)` with geometric growth that cannot abort. */
template <typename T>
bool try_push_back(std::vector<T>& v, const T& value) {
  if (v.size() == v.capacity()) {
    const std::size_t grown = v.capacity() < 16 ? 16 : v.capacity() * 2;
    if (!try_reserve(v, grown)) return false;
  }
  v.push_back(value);
  return true;
}

}  // namespace cs
