package fixture;
/** Authored deterministic static fixture. Not an Android application. */
public class Entry {
    public static int counter;
    public static native int nativeCheck(String input);
    public static int overloaded(int v) { return v + 2; }
    public static int overloaded(String v) { return v.length(); }
    public static int verify(int v) {
        counter = v;
        return Other.compute(v) + overloaded(v) + "STATIC_TOKEN".length();
    }
    public static int guarded(int v) {
        try { return 30 / v; } catch (ArithmeticException e) { return -7; }
    }
    public static long wide(long v) { return (v << 3) ^ 0x123456789L; }
}
