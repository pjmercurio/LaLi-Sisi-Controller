import vosk, sounddevice, queue, json

class NumberNormalizer:
    grammar = json.dumps([
        "move go slide",
        "up down left right",
        "millimeters millimeter mm inches inch in microns micron",
        "zero one two three four five six seven eight nine ten",
        "eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty",
        "thirty forty fifty sixty seventy eighty ninety hundred",
        "point", "and", "water", "pump", "on", "off", "dance",
        "[unk]"  # catch-all for anything outside the grammar
    ])
    _ones = {
        'zero':0,'one':1,'won':1,'two':2,'to':2,'too':2,'three':3,
        'four':4,'for':4,'fore':4,'five':5,'six':6,'seven':7,
        'eight':8,'ate':8,'nine':9,'ten':10,'eleven':11,'twelve':12,
        'thirteen':13,'fourteen':14,'fifteen':15,'sixteen':16,
        'seventeen':17,'eighteen':18,'nineteen':19
    }
    _tens = {
        'twenty':20,'thirty':30,'forty':40,'fourty':40,'fifty':50,
        'sixty':60,'seventy':70,'eighty':80,'ninety':90
    }
    _number_words = set(_ones) | set(_tens) | {'hundred', 'thousand', 'point'}

    @classmethod
    def _convert_chunk(cls, words):
        if 'point' in words:
            idx = words.index('point')
            whole = cls._convert_chunk(words[:idx]) if words[:idx] else 0
            decimal_digits = ''.join(str(cls._ones.get(w, w)) for w in words[idx+1:])
            return float(f"{int(whole)}.{decimal_digits}")

        total, current = 0, 0
        for word in words:
            if word == 'hundred':
                current = (current or 1) * 100
            elif word == 'thousand':
                total = (total + current) * 1000
                current = 0
            elif word in cls._ones:
                current += cls._ones[word]
            elif word in cls._tens:
                current += cls._tens[word]

        val = total + current
        return int(val) if val == int(val) else val

    @classmethod
    def normalize(cls, text):
        words = text.lower().split()
        result = []
        i = 0
        while i < len(words):
            if words[i] in cls._number_words:
                chunk = []
                while i < len(words) and words[i] in cls._number_words:
                    chunk.append(words[i])
                    i += 1
                result.append(str(cls._convert_chunk(chunk)))
            else:
                result.append(words[i])
                i += 1
        return ' '.join(result)

model = vosk.Model("vosk-model-small-en-us-0.15")  # downloaded from alphacephei.com/vosk/models
q = queue.Queue()

def callback(indata, frames, time, status):
    q.put(bytes(indata))

with sounddevice.RawInputStream(samplerate=16000, blocksize=8000, dtype='int16',
                                 channels=1, callback=callback):
    rec = vosk.KaldiRecognizer(model, 16000, NumberNormalizer.grammar)
    while True:
        data = q.get()
        if rec.AcceptWaveform(data):
            result = json.loads(rec.Result())
            numericalResult = NumberNormalizer.normalize(result['text'])
            print(numericalResult)  # your transcript, feed into your parser

