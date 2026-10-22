# Voices walkthrough scenes with Kokoro (FLOW-437); run by kokoro.ts through `uv run`.
#
# stdin:  {"voice": "af_heart", "langCode": "a", "speed": 1, "scenes": [{"text": "...", "wav": "/abs/x.wav"}]}
# stdout: {"scenes": [{"duration": 12.48, "words": [{"text": "Kokoro", "start": 0.375, "end": 0.81}]}]}
#
# Each scene's audio goes to its wav file at 24 kHz. Word times are seconds from the start of the
# scene. A speaker the Hub confirms is absent exits 3, and one that is neither cached nor
# downloadable exits 4, both before anything is voiced.

import json
import sys

import numpy
import soundfile
from huggingface_hub.errors import EntryNotFoundError, LocalEntryNotFoundError
from kokoro import KPipeline

REPO_ID = "hexgrad/Kokoro-82M"
SAMPLE_RATE = 24000
UNKNOWN_SPEAKER_EXIT = 3
UNFETCHED_SPEAKER_EXIT = 4


def main():
    request = json.load(sys.stdin)
    voice = request["voice"]
    pipeline = KPipeline(lang_code=request["langCode"], repo_id=REPO_ID)
    try:
        pipeline.load_voice(voice)
    except LocalEntryNotFoundError:
        print(f"Kokoro could not download speaker {voice}", file=sys.stderr)
        sys.exit(UNFETCHED_SPEAKER_EXIT)
    except EntryNotFoundError:
        print(f"Kokoro has no speaker {voice}", file=sys.stderr)
        sys.exit(UNKNOWN_SPEAKER_EXIT)
    scenes = [narrate(pipeline, voice, request["speed"], scene) for scene in request["scenes"]]
    json.dump({"scenes": scenes}, sys.stdout)


# Kokoro voices long text in chunks whose timestamps each start again near 0, so every word time is
# moved on by the length of the chunks before it. Tokens without timestamps are left out.
def narrate(pipeline, voice, speed, scene):
    chunks = []
    words = []
    offset = 0.0
    for result in pipeline(scene["text"], voice=voice, speed=speed):
        if result.audio is None:
            continue
        audio = result.audio.numpy()
        for token in result.tokens or []:
            if token.start_ts is not None and token.end_ts is not None:
                words.append(
                    {"text": token.text, "start": offset + token.start_ts, "end": offset + token.end_ts}
                )
        chunks.append(audio)
        offset += len(audio) / SAMPLE_RATE
    audio = numpy.concatenate(chunks) if chunks else numpy.zeros(0, dtype=numpy.float32)
    soundfile.write(scene["wav"], audio, SAMPLE_RATE)
    return {"duration": offset, "words": words}


main()
