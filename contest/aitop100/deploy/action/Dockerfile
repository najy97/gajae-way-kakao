# Action sidecar: forwards the contest action API with the participant token and
# serves customer media (kakaocdn images/audio) to the persona, with local Korean STT.
FROM python:3.12-slim
RUN pip install --no-cache-dir faster-whisper==1.1.1 "av<14" requests
# Bake the STT model into the image so a cold start never downloads.
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8', download_root='/models')" && chmod -R a+rX /models
ENV WHISPER_MODEL=small WHISPER_ROOT=/models HF_HUB_OFFLINE=1
USER 65534:65534
ENTRYPOINT ["python3", "-u", "/action/proxy.py"]
