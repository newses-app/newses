package app.newses.background;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The bearer token for the background job, encrypted with a key of its own in the Android
 * Keystore. The app hands it over through the bridge, so the job does not depend on how the secure
 * storage plugin keeps the app's copy.
 */
final class TokenVault {

    private static final String ALIAS = "newses-background-sync";
    private static final String KEY = "token";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";

    private TokenVault() {}

    static void write(SharedPreferences prefs, String token) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] sealed = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
        String value = encode(cipher.getIV()) + ":" + encode(sealed);
        prefs.edit().putString(KEY, value).apply();
    }

    /** The token; null when none was handed over, or it can no longer be read. */
    static String read(SharedPreferences prefs) {
        String value = prefs.getString(KEY, null);
        if (value == null) return null;
        String[] parts = value.split(":", 2);
        if (parts.length != 2) return null;
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, decode(parts[0])));
            return new String(cipher.doFinal(decode(parts[1])), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException e) {
            return null;
        }
    }

    static void clear(SharedPreferences prefs) {
        prefs.edit().remove(KEY).apply();
    }

    private static SecretKey key() throws GeneralSecurityException {
        try {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        } catch (java.io.IOException e) {
            throw new GeneralSecurityException(e);
        }
        KeyGenerator generator =
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(
            new KeyGenParameterSpec.Builder(
                ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build()
        );
        return generator.generateKey();
    }

    private static String encode(byte[] bytes) {
        return Base64.encodeToString(bytes, Base64.NO_WRAP);
    }

    private static byte[] decode(String text) {
        return Base64.decode(text, Base64.NO_WRAP);
    }
}
