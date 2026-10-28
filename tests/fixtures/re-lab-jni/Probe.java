package org.dsh.relab;

/** Authored known-answer host fixture; not an Android or anti-instrumentation test. */
public final class Probe {
    static { System.loadLibrary("dsh_re_probe"); }
    public static native int exported(int input);
    public static native int registered(int input);

    public static void main(String[] args) {
        int[] inputs = {0, 1, -1, Integer.MAX_VALUE};
        StringBuilder json = new StringBuilder("{\"backend\":\"host-jvm-jni\",\"results\":[");
        for (int i = 0; i < inputs.length; i++) {
            if (i > 0) json.append(',');
            int x = inputs[i];
            json.append("{\"input\":").append(x)
                .append(",\"exported\":").append(exported(x))
                .append(",\"registered\":").append(registered(x)).append('}');
        }
        System.out.println(json.append("]}"));
    }
}
