import unittest
from tv_swap_report import marker_observation


class MovingSquare(unittest.TestCase):
    def setUp(self):
        self.width,self.height=64,16
        self.base=bytes([14,31,80])*(self.width*self.height)
        self.left=self.mark(self.base,4)
        self.right=self.mark(self.base,28)

    def mark(self,frame,x):
        image=bytearray(frame)
        for y in range(4,12):
            offset=(y*self.width+x)*3
            image[offset:offset+24]=bytes((255,0,255))*8
        return bytes(image)

    def observe(self,right,clear):
        return marker_observation([self.base,self.left,right,clear],self.width,self.height)

    def test_moved_and_restored(self):
        result=self.observe(self.right,self.base)
        self.assertTrue(result['passed'])
        self.assertEqual(result['right'],[28,4,36,12])

    def test_rejects_left_trail(self):
        self.assertFalse(self.observe(self.mark(self.right,4),self.base)['passed'])

    def test_rejects_stale_final_frame(self):
        self.assertFalse(self.observe(self.right,self.right)['passed'])

    def test_rejects_wrong_displacement(self):
        self.assertFalse(self.observe(self.mark(self.base,27),self.base)['passed'])
