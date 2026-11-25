import gzip
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from tv_stage_analysis import calibration_edges
from tv_release_gate import COMPOSITOR_HOLDOUTS, swap_readbacks
from tv_presentation import reconcile

PACKAGE='net.test.battlecity'

def field(number, value):
    def varint(n):
        data=bytearray()
        while n>=128:
            data.append(128 | (n & 127))
            n>>=7
        return bytes(data)+bytes([n])
    if isinstance(value,int):
        return varint(number<<3)+varint(value)
    return varint(number<<3|2)+varint(len(value))+value

def receipt(frame,stamp,layer='SurfaceView '+PACKAGE,kind=8):
    event=field(1,frame)+field(2,kind)+field(3,layer.encode())
    return field(1,field(8,stamp)+field(57,field(1,event)))

class PresentationTest(unittest.TestCase):
    def check(self,trace=b'',shown=b'',mapping=b'1,11,80,20\n1,12,81,50\n',count=2):
        row={'frames':count,'lastSubmittedFrame':12}
        reconcile([row],mapping,shown,trace,PACKAGE)
        return row['verifiedPresentations'],row['displayEvidence']

    def test_receipts(self):
        self.assertEqual(self.check(shown=b'1,11,80,200\n1,12,81,300\n'),(2,'EGL_DISPLAY_PRESENT_TIME_ANDROID'))
        self.assertEqual(self.check(receipt(80,200)+receipt(81,300)),(2,'SurfaceFlinger PRESENT_FENCE'))

    def test_ambiguous_or_missing(self):
        first=receipt(80,200)
        second=receipt(81,300)
        for trace in (b'',first,first+receipt(81,190),first+receipt(81,300,'SurfaceView other'),
                      first+receipt(81,300,kind=7),receipt(80,200,'SurfaceView '+PACKAGE+'.other')+receipt(81,300,'SurfaceView '+PACKAGE+'.other'),first+first+second,b'\x0a\xff',
                      first+second+receipt(80,200,'SurfaceView #2 '+PACKAGE)+receipt(81,300,'SurfaceView #2 '+PACKAGE)):
            self.assertEqual(self.check(trace),(0,'unverified'))
        for mapping in (b'',b'1,11,80,20\n2,12,81,50',b'1,11,80,20\n1,12,82,50',b'1,12,81,50',b'1,11,80,20\n1,11,80,20\n1,12,81,50'):
            self.assertEqual(self.check(first+second,mapping=mapping),(0,'unverified'))
        for shown in (b'1,11,80,-2\n1,12,81,300',b'1,11,80,200\n1,12,81,300\n1,12,81,300'):
            self.assertEqual(self.check(shown=shown),(0,'unverified'))
        self.assertEqual(self.check(count=0),(0,'unverified'))

class SwapReadbackTest(unittest.TestCase):
    def test_black_window_cannot_register_calibration_lines(self):
        w,h=64,180
        black=(w,h,bytes(w*h*3))
        result=calibration_edges(black,black)
        self.assertIsNone(result['offset'])
        self.assertEqual(result['edgeLeakage'],{})

    def test_repeated_baseline_bounds_each_channel(self):
        with TemporaryDirectory() as tmp:
            root=Path(tmp)
            folder=root/'held-out'
            folder.mkdir()
            self.assertFalse(swap_readbacks(root))
            def write(scene,mode,rgb):
                (folder/f'{scene}-{mode}-swap.ppm.gz').write_bytes(gzip.compress(b'P6\n1 1\n255\n'+bytes(rgb)))
            for scene in COMPOSITOR_HOLDOUTS:
                write(scene,'baseline',(8,30,50))
                write(scene,'repeat',(8,34,48))
                write(scene,'candidate',(8,28,51))
            self.assertTrue(swap_readbacks(root))
            write('moving-626','candidate',(9,28,51))
            self.assertFalse(swap_readbacks(root))


if __name__=='__main__':
    unittest.main()
