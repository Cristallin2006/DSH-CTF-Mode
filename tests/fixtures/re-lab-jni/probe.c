#include <jni.h>
#include <stdint.h>

JNIEXPORT jint JNICALL Java_org_dsh_relab_Probe_exported(JNIEnv *env, jclass type, jint x) {
    (void)env; (void)type;
    return (jint)((uint32_t)x ^ UINT32_C(0x5a5a));
}

static jint registered_probe(JNIEnv *env, jclass type, jint x) {
    (void)env; (void)type;
    return (jint)((uint32_t)x * UINT32_C(3) + UINT32_C(7));
}

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *reserved) {
    JNIEnv *env = NULL;
    (void)reserved;
    if ((*vm)->GetEnv(vm, (void **)&env, JNI_VERSION_1_6) != JNI_OK) return JNI_ERR;
    jclass probe = (*env)->FindClass(env, "org/dsh/relab/Probe");
    if (probe == NULL) return JNI_ERR;
    JNINativeMethod methods[] = {{"registered", "(I)I", (void *)registered_probe}};
    if ((*env)->RegisterNatives(env, probe, methods, 1) != JNI_OK) return JNI_ERR;
    return JNI_VERSION_1_6;
}
