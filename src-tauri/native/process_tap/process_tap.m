#import <CoreAudio/AudioHardware.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <AudioToolbox/AudioQueue.h>
#import <Foundation/Foundation.h>
#include <math.h>
#include <stdint.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef void (*QwenAudioTapCallback)(const int16_t *samples,
                                     uint32_t frame_count,
                                     uint32_t sample_rate,
                                     void *context);

typedef struct {
  AudioObjectID tap_id;
  AudioObjectID aggregate_id;
  AudioDeviceIOProcID io_proc;
  QwenAudioTapCallback callback;
  void *context;
  Float64 sample_rate;
  AudioStreamBasicDescription format;
  AudioQueueRef playback_queue;
  bool playback_started;
  atomic_uint playback_pending_buffers;
  bool started;
} QwenAudioTap;

static void playback_buffer_finished(void *context,
                                     AudioQueueRef queue,
                                     AudioQueueBufferRef buffer) {
  QwenAudioTap *tap = context;
  unsigned int pending = atomic_load(&tap->playback_pending_buffers);
  while (pending > 0 &&
         !atomic_compare_exchange_weak(&tap->playback_pending_buffers,
                                       &pending, pending - 1)) {
  }
  AudioQueueFreeBuffer(queue, buffer);
}

static OSStatus create_playback_queue(QwenAudioTap *tap) {
  AudioStreamBasicDescription format = {0};
  format.mSampleRate = 48000.0;
  format.mFormatID = kAudioFormatLinearPCM;
  format.mFormatFlags =
      kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked;
  format.mBytesPerPacket = sizeof(int16_t);
  format.mFramesPerPacket = 1;
  format.mBytesPerFrame = sizeof(int16_t);
  format.mChannelsPerFrame = 1;
  format.mBitsPerChannel = 16;
  OSStatus status =
      AudioQueueNewOutput(&format, playback_buffer_finished, tap, NULL, NULL, 0,
                          &tap->playback_queue);
  if (status != noErr) {
    return status;
  }
  AudioQueueSetParameter(tap->playback_queue, kAudioQueueParam_Volume, 1.0f);
  tap->playback_started = false;
  atomic_store(&tap->playback_pending_buffers, 0);
  return noErr;
}

static void dispose_playback_queue(QwenAudioTap *tap) {
  if (tap->playback_queue == NULL) {
    return;
  }
  AudioQueueStop(tap->playback_queue, true);
  AudioQueueDispose(tap->playback_queue, true);
  tap->playback_queue = NULL;
  tap->playback_started = false;
}

static void write_error(char *target, size_t capacity, NSString *message) {
  if (target == NULL || capacity == 0) {
    return;
  }
  const char *text = message.UTF8String ?: "Core Audio Process Tap failed";
  snprintf(target, capacity, "%s", text);
}

static NSString *status_message(NSString *operation, OSStatus status) {
  UInt32 value = CFSwapInt32HostToBig((UInt32)status);
  char code[5] = {0};
  memcpy(code, &value, 4);
  bool printable = true;
  for (size_t index = 0; index < 4; index += 1) {
    printable = printable && code[index] >= 32 && code[index] <= 126;
  }
  return printable
             ? [NSString stringWithFormat:@"%@ (%s)", operation, code]
             : [NSString stringWithFormat:@"%@ (%d)", operation, (int)status];
}

static AudioObjectID current_process_object_id(void) {
  AudioObjectPropertyAddress address = {
      kAudioHardwarePropertyTranslatePIDToProcessObject,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain,
  };
  pid_t pid = getpid();
  AudioObjectID process_id = kAudioObjectUnknown;
  UInt32 process_id_size = sizeof(process_id);
  OSStatus status = AudioObjectGetPropertyData(
      kAudioObjectSystemObject, &address, sizeof(pid), &pid, &process_id_size,
      &process_id);
  return status == noErr ? process_id : kAudioObjectUnknown;
}

static OSStatus set_tap_mute_behavior(QwenAudioTap *tap,
                                      bool mute_original) {
  AudioObjectPropertyAddress address = {
      kAudioTapPropertyDescription,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain,
  };
  CFTypeRef description_ref = NULL;
  UInt32 size = sizeof(description_ref);
  OSStatus status = AudioObjectGetPropertyData(
      tap->tap_id, &address, 0, NULL, &size, &description_ref);
  if (status != noErr || description_ref == NULL) {
    return status == noErr ? -1 : status;
  }
  CATapDescription *description =
      (__bridge CATapDescription *)description_ref;
  description.muteBehavior =
      mute_original ? CATapMutedWhenTapped : CATapUnmuted;
  size = sizeof(description_ref);
  status = AudioObjectSetPropertyData(tap->tap_id, &address, 0, NULL, size,
                                      &description_ref);
  CFRelease(description_ref);
  return status;
}

static NSArray<NSNumber *> *current_process_audio_objects(void) {
  AudioObjectPropertyAddress list_address = {
      kAudioHardwarePropertyProcessObjectList,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain,
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &list_address, 0,
                                     NULL, &size) != noErr ||
      size == 0) {
    return @[];
  }
  UInt32 count = size / sizeof(AudioObjectID);
  AudioObjectID *objects = calloc(count, sizeof(AudioObjectID));
  if (objects == NULL) {
    return @[];
  }
  OSStatus status = AudioObjectGetPropertyData(kAudioObjectSystemObject,
                                                &list_address, 0, NULL, &size,
                                                objects);
  if (status != noErr) {
    free(objects);
    return @[];
  }

  pid_t current_pid = NSProcessInfo.processInfo.processIdentifier;
  NSMutableArray<NSNumber *> *matches = [NSMutableArray array];
  AudioObjectPropertyAddress pid_address = {
      kAudioProcessPropertyPID,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain,
  };
  for (UInt32 index = 0; index < count; index += 1) {
    pid_t pid = 0;
    UInt32 pid_size = sizeof(pid);
    if (AudioObjectGetPropertyData(objects[index], &pid_address, 0, NULL,
                                   &pid_size, &pid) == noErr &&
        pid == current_pid) {
      [matches addObject:@(objects[index])];
    }
  }
  free(objects);
  return matches;
}

static OSStatus tap_io_proc(AudioObjectID device,
                            const AudioTimeStamp *now,
                            const AudioBufferList *input,
                            const AudioTimeStamp *input_time,
                            AudioBufferList *output,
                            const AudioTimeStamp *output_time,
                            void *context) {
  (void)device;
  (void)now;
  (void)input_time;
  (void)output;
  (void)output_time;
  QwenAudioTap *tap = context;
  if (tap == NULL || tap->callback == NULL || input == NULL ||
      input->mNumberBuffers == 0) {
    return noErr;
  }

  const AudioBuffer *first = &input->mBuffers[0];
  if (first->mData == NULL || first->mDataByteSize == 0) {
    return noErr;
  }
  UInt32 bits = MAX(tap->format.mBitsPerChannel, 16);
  UInt32 bytes_per_sample = MAX(bits / 8, 2);
  bool planar =
      (tap->format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0 ||
      (input->mNumberBuffers > 1 && first->mNumberChannels == 1);
  UInt32 channels_in_first = MAX(first->mNumberChannels, 1);
  UInt32 frame_count =
      first->mDataByteSize /
      (bytes_per_sample * (planar ? 1 : channels_in_first));
  if (frame_count == 0) {
    return noErr;
  }

  int16_t *mono = malloc(frame_count * sizeof(int16_t));
  if (mono == NULL) {
    return noErr;
  }
  for (UInt32 frame = 0; frame < frame_count; frame += 1) {
    float sum = 0.0f;
    UInt32 channels = 0;
    if (planar) {
      for (UInt32 buffer_index = 0; buffer_index < input->mNumberBuffers;
           buffer_index += 1) {
        const AudioBuffer *buffer = &input->mBuffers[buffer_index];
        if (buffer->mData != NULL &&
            buffer->mDataByteSize >= (frame + 1) * bytes_per_sample) {
          UInt32 sample_index = frame;
          if ((tap->format.mFormatFlags & kAudioFormatFlagIsFloat) != 0) {
            sum += bits == 64
                       ? (float)((const double *)buffer->mData)[sample_index]
                       : ((const float *)buffer->mData)[sample_index];
          } else if (bits == 32) {
            sum += (float)((const int32_t *)buffer->mData)[sample_index] /
                   2147483647.0f;
          } else {
            sum += (float)((const int16_t *)buffer->mData)[sample_index] /
                   32767.0f;
          }
          channels += 1;
        }
      }
    } else {
      channels = MAX(first->mNumberChannels, 1);
      for (UInt32 channel = 0; channel < channels; channel += 1) {
        UInt32 sample_index = frame * channels + channel;
        if ((tap->format.mFormatFlags & kAudioFormatFlagIsFloat) != 0) {
          sum += bits == 64
                     ? (float)((const double *)first->mData)[sample_index]
                     : ((const float *)first->mData)[sample_index];
        } else if (bits == 32) {
          sum += (float)((const int32_t *)first->mData)[sample_index] /
                 2147483647.0f;
        } else {
          sum += (float)((const int16_t *)first->mData)[sample_index] /
                 32767.0f;
        }
      }
    }
    float sample = channels > 0 ? sum / (float)channels : 0.0f;
    sample = fmaxf(-1.0f, fminf(1.0f, sample));
    mono[frame] = (int16_t)lrintf(sample * 32767.0f);
  }
  tap->callback(mono, frame_count, (uint32_t)llround(tap->sample_rate),
                tap->context);
  free(mono);
  return noErr;
}

void *qwen_audio_process_tap_start(QwenAudioTapCallback callback,
                                   void *context,
                                   bool mute_original,
                                   uint32_t *sample_rate,
                                   char *error,
                                   size_t error_capacity) {
  @autoreleasepool {
    if (@available(macOS 14.2, *)) {
      QwenAudioTap *tap = calloc(1, sizeof(QwenAudioTap));
      if (tap == NULL) {
        write_error(error, error_capacity, @"无法分配 Process Tap");
        return NULL;
      }
      tap->callback = callback;
      tap->context = context;
      atomic_init(&tap->playback_pending_buffers, 0);

      AudioObjectID process_id = current_process_object_id();
      NSArray<NSNumber *> *excluded_processes =
          process_id == kAudioObjectUnknown ? @[] : @[ @(process_id) ];
      CATapDescription *description = [[CATapDescription alloc]
          initStereoGlobalTapButExcludeProcesses:excluded_processes];
      description.name = @"QwenAudio Toolkits System Audio";
      description.privateTap = YES;
      description.muteBehavior =
          mute_original ? CATapMutedWhenTapped : CATapUnmuted;
      NSLog(@"QwenAudio Process Tap excluding process object %u",
            process_id);

      OSStatus status =
          AudioHardwareCreateProcessTap(description, &tap->tap_id);
      if (status != noErr) {
        write_error(error, error_capacity,
                    status_message(@"无法创建 Process Tap", status));
        dispose_playback_queue(tap);
        free(tap);
        return NULL;
      }

      AudioObjectPropertyAddress uid_address = {
          kAudioTapPropertyUID,
          kAudioObjectPropertyScopeGlobal,
          kAudioObjectPropertyElementMain,
      };
      CFStringRef tap_uid = NULL;
      UInt32 uid_size = sizeof(tap_uid);
      status = AudioObjectGetPropertyData(tap->tap_id, &uid_address, 0, NULL,
                                          &uid_size, &tap_uid);
      if (status != noErr || tap_uid == NULL) {
        write_error(error, error_capacity,
                    status_message(@"无法读取 Process Tap UID", status));
        AudioHardwareDestroyProcessTap(tap->tap_id);
        dispose_playback_queue(tap);
        free(tap);
        return NULL;
      }

      AudioDeviceID output_device = kAudioObjectUnknown;
      AudioObjectPropertyAddress output_address = {
          kAudioHardwarePropertyDefaultSystemOutputDevice,
          kAudioObjectPropertyScopeGlobal,
          kAudioObjectPropertyElementMain,
      };
      UInt32 output_size = sizeof(output_device);
      status = AudioObjectGetPropertyData(
          kAudioObjectSystemObject, &output_address, 0, NULL, &output_size,
          &output_device);
      if (status != noErr || output_device == kAudioObjectUnknown) {
        write_error(error, error_capacity,
                    status_message(@"无法读取默认音频输出设备", status));
        CFRelease(tap_uid);
        AudioHardwareDestroyProcessTap(tap->tap_id);
        dispose_playback_queue(tap);
        free(tap);
        return NULL;
      }

      AudioObjectPropertyAddress output_uid_address = {
          kAudioDevicePropertyDeviceUID,
          kAudioObjectPropertyScopeGlobal,
          kAudioObjectPropertyElementMain,
      };
      CFStringRef output_uid = NULL;
      UInt32 output_uid_size = sizeof(output_uid);
      status = AudioObjectGetPropertyData(output_device, &output_uid_address, 0,
                                          NULL, &output_uid_size, &output_uid);
      if (status != noErr || output_uid == NULL) {
        write_error(error, error_capacity,
                    status_message(@"无法读取默认音频输出 UID", status));
        CFRelease(tap_uid);
        AudioHardwareDestroyProcessTap(tap->tap_id);
        dispose_playback_queue(tap);
        free(tap);
        return NULL;
      }

      NSString *tap_uid_string = [(__bridge NSString *)tap_uid copy];
      NSString *output_uid_string = [(__bridge NSString *)output_uid copy];
      CFRelease(tap_uid);
      CFRelease(output_uid);
      NSString *aggregate_uid = NSUUID.UUID.UUIDString;
      NSDictionary *aggregate_description = @{
        @kAudioAggregateDeviceNameKey : @"QwenAudio Toolkits Process Tap",
        @kAudioAggregateDeviceUIDKey : aggregate_uid,
        @kAudioAggregateDeviceMainSubDeviceKey : output_uid_string,
        @kAudioAggregateDeviceIsPrivateKey : @YES,
        @kAudioAggregateDeviceIsStackedKey : @NO,
        @kAudioAggregateDeviceTapAutoStartKey : @YES,
        @kAudioAggregateDeviceSubDeviceListKey : @[
          @{ @kAudioSubDeviceUIDKey : output_uid_string }
        ],
        @kAudioAggregateDeviceTapListKey : @[
          @{
            @kAudioSubTapUIDKey : tap_uid_string,
            @kAudioSubTapDriftCompensationKey : @YES,
          }
        ],
      };
      status = AudioHardwareCreateAggregateDevice(
          (__bridge CFDictionaryRef)aggregate_description,
          &tap->aggregate_id);
      if (status != noErr) {
        write_error(error, error_capacity,
                    status_message(@"无法创建 Process Tap 音频设备", status));
        AudioHardwareDestroyProcessTap(tap->tap_id);
        dispose_playback_queue(tap);
        free(tap);
        return NULL;
      }

      AudioObjectPropertyAddress format_address = {
          kAudioTapPropertyFormat,
          kAudioObjectPropertyScopeGlobal,
          kAudioObjectPropertyElementMain,
      };
      UInt32 format_size = sizeof(tap->format);
      status = AudioObjectGetPropertyData(
          tap->tap_id, &format_address, 0, NULL, &format_size,
          &tap->format);
      if (status != noErr ||
          tap->format.mFormatID != kAudioFormatLinearPCM ||
          tap->format.mSampleRate <= 0.0) {
        NSString *format_error = [NSString
            stringWithFormat:
                @"Process Tap 音频格式不可用：status=%d format=%u flags=%u "
                 "rate=%.0f channels=%u bits=%u",
                (int)status, (unsigned)tap->format.mFormatID,
                (unsigned)tap->format.mFormatFlags,
                tap->format.mSampleRate,
                (unsigned)tap->format.mChannelsPerFrame,
                (unsigned)tap->format.mBitsPerChannel];
        write_error(error, error_capacity, format_error);
        AudioHardwareDestroyAggregateDevice(tap->aggregate_id);
        AudioHardwareDestroyProcessTap(tap->tap_id);
        dispose_playback_queue(tap);
        free(tap);
        return NULL;
      }
      tap->sample_rate = tap->format.mSampleRate;

      status = AudioDeviceCreateIOProcID(tap->aggregate_id, tap_io_proc, tap,
                                         &tap->io_proc);
      if (status != noErr) {
        write_error(error, error_capacity,
                    status_message(@"无法创建 Process Tap 回调", status));
      } else {
        status = AudioDeviceStart(tap->aggregate_id, tap->io_proc);
        if (status != noErr) {
          write_error(error, error_capacity,
                      status_message(@"无法启动 Process Tap 设备", status));
        }
      }
      if (status != noErr) {
        if (tap->io_proc != NULL) {
          AudioDeviceDestroyIOProcID(tap->aggregate_id, tap->io_proc);
        }
        AudioHardwareDestroyAggregateDevice(tap->aggregate_id);
        AudioHardwareDestroyProcessTap(tap->tap_id);
        dispose_playback_queue(tap);
        free(tap);
        return NULL;
      }
      tap->started = true;

      status = create_playback_queue(tap);
      if (status != noErr) {
        write_error(error, error_capacity,
                    status_message(@"无法创建原生监听输出", status));
        AudioDeviceStop(tap->aggregate_id, tap->io_proc);
        AudioDeviceDestroyIOProcID(tap->aggregate_id, tap->io_proc);
        AudioHardwareDestroyAggregateDevice(tap->aggregate_id);
        AudioHardwareDestroyProcessTap(tap->tap_id);
        dispose_playback_queue(tap);
        free(tap);
        return NULL;
      }

      // Excluding the app's own playback (to avoid recapturing it) is best-effort:
      // on macOS 26+ bundleIDs is used, on older systems the legacy process
      // list. If the exclusion can't be applied the tap still captures the
      // whole device, so system audio capture proceeds.
      if (!@available(macOS 26.0, *)) {
        usleep(20000);
        NSArray<NSNumber *> *output_processes = current_process_audio_objects();
        if (output_processes.count > 0) {
          description.processes = output_processes;
        }
      }
      AudioObjectPropertyAddress description_address = {
          kAudioTapPropertyDescription,
          kAudioObjectPropertyScopeGlobal,
          kAudioObjectPropertyElementMain,
      };
      CFTypeRef description_ref = (__bridge CFTypeRef)description;
      UInt32 description_size = sizeof(description_ref);
      status = AudioObjectSetPropertyData(tap->tap_id, &description_address, 0,
                                          NULL, description_size,
                                          &description_ref);
      if (status != noErr) {
        write_error(error, error_capacity,
                    status_message(@"未能排除本应用输出，按完整设备采集", status));
      }

      if (sample_rate != NULL) {
        *sample_rate = (uint32_t)llround(tap->sample_rate);
      }
      return tap;
    }
    write_error(error, error_capacity,
                @"电脑音频接管需要 macOS 14.2 或更高版本");
    return NULL;
  }
}

int32_t qwen_audio_process_tap_play_pcm(void *handle,
                                        const int16_t *samples,
                                        uint32_t frame_count,
                                        char *error,
                                        size_t error_capacity) {
  QwenAudioTap *tap = handle;
  if (tap == NULL || tap->playback_queue == NULL || samples == NULL ||
      frame_count == 0) {
    write_error(error, error_capacity, @"原生监听输出不可用");
    return -1;
  }
  UInt32 byte_count = frame_count * sizeof(int16_t);
  AudioQueueBufferRef buffer = NULL;
  OSStatus status =
      AudioQueueAllocateBuffer(tap->playback_queue, byte_count, &buffer);
  if (status != noErr || buffer == NULL) {
    write_error(error, error_capacity,
                status_message(@"无法分配监听音频缓冲区", status));
    return status == noErr ? -1 : status;
  }
  memcpy(buffer->mAudioData, samples, byte_count);
  buffer->mAudioDataByteSize = byte_count;
  status = AudioQueueEnqueueBuffer(tap->playback_queue, buffer, 0, NULL);
  if (status != noErr) {
    AudioQueueFreeBuffer(tap->playback_queue, buffer);
    write_error(error, error_capacity,
                status_message(@"无法播放监听音频", status));
    return status;
  }
  unsigned int pending = atomic_fetch_add(&tap->playback_pending_buffers, 1) + 1;
  UInt32 running = 0;
  UInt32 running_size = sizeof(running);
  status = AudioQueueGetProperty(tap->playback_queue,
                                 kAudioQueueProperty_IsRunning, &running,
                                 &running_size);
  if (status == noErr && running == 0) {
    tap->playback_started = false;
  }
  // A single 10 ms buffer commonly underruns before the next Tauri command
  // arrives. Prebuffer a few frames on startup and after an underrun.
  if (!tap->playback_started && pending >= 3) {
    status = AudioQueueStart(tap->playback_queue, NULL);
    tap->playback_started = status == noErr;
    if (status != noErr) {
      write_error(error, error_capacity,
                  status_message(@"无法启动监听音频输出", status));
    }
  }
  return status;
}

int32_t qwen_audio_process_tap_flush_playback(void *handle) {
  QwenAudioTap *tap = handle;
  if (tap == NULL || tap->playback_queue == NULL) {
    return -1;
  }
  OSStatus status = noErr;
  if (tap->playback_started) {
    status = AudioQueueStop(tap->playback_queue, true);
  }
  if (status == noErr) {
    status = AudioQueueReset(tap->playback_queue);
  }
  tap->playback_started = false;
  atomic_store(&tap->playback_pending_buffers, 0);
  return status;
}

int32_t qwen_audio_process_tap_pause(void *handle,
                                     char *error,
                                     size_t error_capacity) {
  QwenAudioTap *tap = handle;
  if (tap == NULL) {
    write_error(error, error_capacity, @"Process Tap 不可用");
    return -1;
  }
  qwen_audio_process_tap_flush_playback(handle);
  if (!tap->started) {
    return noErr;
  }
  OSStatus status = AudioDeviceStop(tap->aggregate_id, tap->io_proc);
  if (status != noErr) {
    write_error(error, error_capacity,
                status_message(@"无法暂停 Process Tap", status));
    return status;
  }
  tap->started = false;
  return noErr;
}

int32_t qwen_audio_process_tap_resume(void *handle,
                                      bool mute_original,
                                      char *error,
                                      size_t error_capacity) {
  QwenAudioTap *tap = handle;
  if (tap == NULL) {
    write_error(error, error_capacity, @"Process Tap 不可用");
    return -1;
  }
  if (tap->started) {
    return noErr;
  }
  OSStatus status = set_tap_mute_behavior(tap, mute_original);
  if (status != noErr) {
    // Mute-behavior is best-effort: the tap still starts and captures with its
    // current mute behavior.
    write_error(error, error_capacity,
                status_message(@"未能切换监听模式，按当前模式继续", status));
  }
  status = AudioDeviceStart(tap->aggregate_id, tap->io_proc);
  if (status != noErr) {
    write_error(error, error_capacity,
                status_message(@"无法恢复 Process Tap", status));
    return status;
  }
  tap->started = true;
  return noErr;
}

void qwen_audio_process_tap_stop(void *handle) {
  @autoreleasepool {
    QwenAudioTap *tap = handle;
    if (tap == NULL) {
      return;
    }
    dispose_playback_queue(tap);
    if (tap->started) {
      AudioDeviceStop(tap->aggregate_id, tap->io_proc);
      tap->started = false;
    }
    if (tap->io_proc != NULL) {
      AudioDeviceDestroyIOProcID(tap->aggregate_id, tap->io_proc);
    }
    if (tap->aggregate_id != kAudioObjectUnknown) {
      AudioHardwareDestroyAggregateDevice(tap->aggregate_id);
    }
    if (tap->tap_id != kAudioObjectUnknown) {
      AudioHardwareDestroyProcessTap(tap->tap_id);
    }
    // Core Audio retires process and aggregate objects asynchronously.
    usleep(50000);
    free(tap);
  }
}
