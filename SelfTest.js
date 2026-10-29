/**
 * SelfTest.js
 * ข้อมูลทดสอบสำหรับ selfTest() ใน Code.js (สร้างจาก OpenSSL ไม่ต้องแก้)
 */
function SELF_TEST_VECTOR_() {
  return {
    "cred": {
      "publicKey": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEwo9eMG5sc1O8_JoeCQT6MQ19zVM47jB9OvJn7KJeHyq38JfABFw-W6IbhNwVqKV3ahifMWfWrojLuNBllvIxYg",
      "rpId": "self-test.example.com",
      "origin": "https://self-test.example.com",
      "signCount": 0
    },
    "expectedChallenge": "y-QIVQgh4VNzPuORyTOznCVSD5YJbedDZIUt2HADYlg",
    "clientDataJSON": "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoieS1RSVZRZ2g0Vk56UHVPUnlUT3puQ1ZTRDVZSmJlZERaSVV0MkhBRFlsZyIsIm9yaWdpbiI6Imh0dHBzOi8vc2VsZi10ZXN0LmV4YW1wbGUuY29tIiwiY3Jvc3NPcmlnaW4iOmZhbHNlfQ",
    "authenticatorData": "DoiW1SmVyE6WXqABWEr7DD3UfYMxZNKqDNUA85RIHxkFAAAAAQ",
    "signature": "MEUCIQCXPqsC92UX3o3EEQlNqx9pE5w5it_kmSdZgBiBlDPR8gIgBO9Ek0dcbcU2ps7huhrK2P58SguVBHJ99jOSebEm9Zo"
  };
}
