import type { ChangelogEntry } from "./changelog.js";

export const trEntries: ChangelogEntry[] = [
  {
    version: "0.21.0",
    date: "2026-11-13",
    highlights: [
      "Projeler, oturumlar, eklentiler, modeller ve zamanlanmış görevler tek bir masaüstü uygulamasında yaşar.",
      "Her oturum için ajan, plan veya hedef modunu seçin; her araç çağrısı çalışmadan önce izin katmanından geçer.",
      "İşi beş yerleşik alt ajana devredin (keşifçi, kod inceleyici, test çalıştırıcı, düzeltici ve arayüz tasarımcısı); her biri kendi bağlamıyla çalışır.",
      "Herhangi bir OpenAI uyumlu uç noktaya veya yerel model çalışma ortamına bağlanın; çalışan oturumda model değiştirin.",
      "Masaüstünün kendisini eklentilerle genişletin: komutlar, paneller, yüzen araçlar, çalışma paneli görünümleri, ajan araçları, temalar, MCP sunucuları ve arka plan servisleri.",
      "Veriler bu makinede kalır: oturumlar, günlükler ve kimlik bilgileri yerelde tutulur, uygulama telemetri göndermez.",
      "Değişiklikleri diff panelinde inceleyin, arka plan komutlarını izleyin ve oturumun dokunduğu dosyaları çıktı listesinden yeniden açın.",
      "Uygulama açıkken zamanlanmış ajan görevlerini çalıştırın ve konuşma içinde etkileşimli kartlar görüntüleyin.",
    ],
  },
];
