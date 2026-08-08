#include <cstdlib>
#include <cstring>
#include <exception>
#include <string>

#include "kaldifst/csrc/text-normalizer.h"

extern "C" {

char *wetext_apply_rule(const char *rule_path, const char *input,
                        char **error) {
  if (error != nullptr) {
    *error = nullptr;
  }
  try {
    kaldifst::TextNormalizer normalizer(rule_path);
    const std::string output = normalizer.Normalize(input);
    char *result = static_cast<char *>(std::malloc(output.size() + 1));
    if (result == nullptr) {
      throw std::bad_alloc();
    }
    std::memcpy(result, output.c_str(), output.size() + 1);
    return result;
  } catch (const std::exception &exception) {
    if (error != nullptr) {
      const std::string message = exception.what();
      *error = static_cast<char *>(std::malloc(message.size() + 1));
      if (*error != nullptr) {
        std::memcpy(*error, message.c_str(), message.size() + 1);
      }
    }
    return nullptr;
  }
}

void wetext_free_string(char *value) { std::free(value); }

}
