// Android: resolve the app's database directory via JNI.
// Uses ActivityThread.currentApplication() — the standard trick for
// context-less native libraries; fbjni is initialized by React Native
// before any TurboModule call runs.
#include "../DatabasePlatform.h"

#include <fbjni/fbjni.h>

namespace watermelon {

std::string databaseDirectory() {
  using namespace facebook::jni;
  static std::string cached = [] {
    ThreadScope scope;
    auto activityThread = findClassLocal("android/app/ActivityThread");
    auto currentApplication =
        activityThread->getStaticMethod<local_ref<JObject>()>(
            "currentApplication", "()Landroid/app/Application;");
    auto application = currentApplication(activityThread);
    auto contextClass = findClassLocal("android/content/Context");
    auto getDatabasePath = contextClass->getMethod<local_ref<JObject>(
        local_ref<JString>)>("getDatabasePath", "(Ljava/lang/String;)Ljava/io/File;");
    // getDatabasePath ensures the parent exists conceptually; we ask for a
    // placeholder file and take its parent directory
    auto file = getDatabasePath(application, make_jstring("watermelon.db"));
    auto fileClass = findClassLocal("java/io/File");
    auto getParentFile =
        fileClass->getMethod<local_ref<JObject>()>("getParentFile", "()Ljava/io/File;");
    auto parent = getParentFile(file);
    auto mkdirs = fileClass->getMethod<jboolean()>("mkdirs", "()Z");
    mkdirs(parent);
    auto getAbsolutePath = fileClass->getMethod<local_ref<JString>()>(
        "getAbsolutePath", "()Ljava/lang/String;");
    return getAbsolutePath(parent)->toStdString();
  }();
  return cached;
}

} // namespace watermelon
