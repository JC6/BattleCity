// Shared by the imported-buffer and EGL window renderers.
#pragma once
namespace battlecity_tv {
    static GLuint shader(GLenum type, const char *text) {
        GLuint name=glCreateShader(type);
        glShaderSource(name,1,&text,nullptr);
        glCompileShader(name);
        GLint ok=0;
        glGetShaderiv(name,GL_COMPILE_STATUS,&ok);
        if (!ok) { glDeleteShader(name); return 0; }
        return name;
    }

    static GLuint link(const char *vertex,const char *fragment) {
        GLuint vs=shader(GL_VERTEX_SHADER,vertex), fs=shader(GL_FRAGMENT_SHADER,fragment);
        if (!vs || !fs) { if (vs) glDeleteShader(vs); if (fs) glDeleteShader(fs); return 0; }
        GLuint linked=glCreateProgram();
        glAttachShader(linked,vs); glAttachShader(linked,fs); glLinkProgram(linked);
        glDeleteShader(vs); glDeleteShader(fs);
        GLint ok=0; glGetProgramiv(linked,GL_LINK_STATUS,&ok);
        if (!ok) { glDeleteProgram(linked); return 0; }
        return linked;
    }

    inline GLuint raster_program() {
        const char *vertex=R"(#version 300 es
void main() {
    vec2 point=vec2((gl_VertexID << 1) & 2,gl_VertexID & 2);
    gl_Position=vec4(point*2.0-1.0,0.0,1.0);
})";
        const char *fragment=R"(#version 300 es
precision highp float;
precision highp int;
uniform highp usampler2D source;
uniform ivec2 geometry;
uniform ivec2 derivative;
out vec4 color;
void main() {
    ivec2 pos=ivec2(gl_FragCoord.xy);
    if (geometry.y!=0) pos.y=geometry.x-1-pos.y;
    ivec2 samplePos=(pos*derivative+derivative/2) >> 16;
    uint value=texelFetch(source,min(samplePos,textureSize(source,0)-1),0).r;
    uvec3 v=uvec3(value>>11u,(value>>5u)&63u,value&31u);
    color=vec4(vec3(v*uvec3(8,4,8)+v/uvec3(4,16,4))/255.0,1.0);
})";
        return link(vertex,fragment);
    }
}
