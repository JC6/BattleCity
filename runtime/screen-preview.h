// SPDX-License-Identifier: BSD-3-Clause
// Raster reconstruction of the fixed reference used by the English Screen Settings page.
#pragma once

namespace ui {
inline void draw_screen_sample(bitmap_argb32 &image, unsigned picture)
{
    constexpr int width=128, height=112;
    bitmap_argb32 scene(width,height);
    for (int y=0;y<height;++y) for (int x=0;x<width;++x) {
        bool island=x>=16 && y>=13 && x<128-std::max(0,11-(y-13))
            && y<(x<64 ? 99 : 109-std::max(0,x-120));
        rgb_t pixel(57,52,224);
        if (!island && y>14 && (x+3*y)%32<2 && y%8==1) pixel=rgb_t(91,104,244);
        if (island) {
            pixel=((x+(y/2)*3)%4==0 && y%4<2) ? rgb_t(128,155,0) : rgb_t(168,197,5);
            if (x==63 || (x==79 && y>61) || (x==31 && y>60 && y<76)
                || (y==28 && x>=32 && x<64) || (y==45 && x<48)
                || (y==61 && x>=31 && x<64)) pixel=rgb_t(90,65,6);
            if (x<64 && y>=78) {
                int ridge=(y-78+(x%16==0 ? 3 : (x%16)/5))%9;
                if (ridge<=1 || y>=97) pixel=rgb_t(105,47,10);
                else if (ridge==2) pixel=rgb_t(151,75,12);
            }
            if (x>=64 && y>=108-std::max(0,x-120)) pixel=rgb_t(125,58,12);
            for (int n=0;n<5;++n) {
                int dx=x-(96+(n%2)*16),dy=y-(28+n*16);
                if (dx*dx+dy*dy<6) pixel=rgb_t(113,56,7);
            }
            if ((x-55)*(x-55)+(y-35)*(y-35)<12) pixel=rgb_t(38,90,7);
            if ((x-39)*(x-39)+(y-76)*(y-76)<10) pixel=rgb_t(163,56,12);
            if (x>=59 && x<=67 && y>=83 && y<=101) {
                int dx=std::abs(x-64);
                if (dx<=1 || (y>=86 && y<=90 && dx<=y-85) || (y>=94 && dx<=2))
                    pixel=y<90 ? rgb_t(235,240,221) : rgb_t(26,77,35);
            }
        }
        scene.pix(y,x)=pixel;
    }
    // Miniature scoreboard, drawn in the same pixel grid as the island.
    constexpr char digits[]="1UP  HI-SCORE   RD  1";
    constexpr char values[]="  00    30000       00";
    auto score=[&](char const *text,int y) {
        for (int i=0;text[i];++i) {
            unsigned bits=0;
            switch(text[i]) {
            case '0': bits=075557; break; case '1': bits=026227; break;
            case '3': bits=071717; break; case 'U': bits=055557; break;
            case 'P': bits=075744; break; case 'H': bits=055755; break;
            case 'I': bits=072227; break; case '-': bits=000700; break;
            case 'S': bits=074717; break; case 'C': bits=074447; break;
            case 'O': bits=075557; break; case 'R': bits=075765; break;
            case 'E': bits=074747; break; case 'D': bits=065556; break;
            }
            for (int k=0;k<15;++k) if (bits & (1U<<(14-k)))
                scene.pix(y+k/3,22+i*4+k%3)=rgb_t(229,225,238);
        }
    };
    score(digits,1); score(values,7);
    image.allocate(width*2,height*2);
    for (int y=0;y<image.height();++y) for (int x=0;x<image.width();++x) {
        rgb_t pixel=scene.pix(y/2,x/2);
        if (picture & 1) {
            rgb_t right=scene.pix(y/2,std::min(width-1,(x+1)/2));
            rgb_t below=scene.pix(std::min(height-1,(y+1)/2),x/2);
            pixel=rgb_t((2*pixel.r()+right.r()+below.r())/4,(2*pixel.g()+right.g()+below.g())/4,
                        (2*pixel.b()+right.b()+below.b())/4);
        }
        if ((picture & 2) && (y & 1)) pixel=rgb_t(pixel.r()*3/4,pixel.g()*3/4,pixel.b()*3/4);
        image.pix(y,x)=pixel;
    }
}
} // namespace ui
