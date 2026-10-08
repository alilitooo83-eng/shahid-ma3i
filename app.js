const video = document.getElementById("video");
const status = document.getElementById("status");

document.getElementById("cameraBtn").addEventListener("click", startCamera);
document.getElementById("createBtn").addEventListener("click", createSession);
document.getElementById("joinBtn").addEventListener("click", joinSession);

async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
           const stream = await navigator.mediaDevices.getUserMedia({
    video: {
        facingMode: {
            ideal: "environment"
        }
    },
    audio: false
});
            audio: false
        });

        video.srcObject = stream;
        status.innerHTML = "✅ الكاميرا تعمل بنجاح";

    } catch (e) {
        status.innerHTML = "❌ تعذر تشغيل الكاميرا";
        alert("خطأ: " + e.message);
    }
}

function createSession() {
    const code = Math.floor(100000 + Math.random() * 900000);
    document.getElementById("sessionCode").innerHTML = code;
    status.innerHTML = "🟢 تم إنشاء الجلسة";
}

function joinSession() {
    const code = document.getElementById("joinInput").value.trim();

    if (code === "") {
        alert("أدخل رمز الجلسة");
        return;
    }

    status.innerHTML = "🔵 سيتم الانضمام إلى الجلسة: " + code;
}
