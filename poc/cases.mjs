const single = (id, source, expect, standard = 'c++17') => ({ id, files: { [`${id}.cpp`]: source }, sources: [`${id}.cpp`], standard, expect });
const hello = '#include <iostream>\nint main() { std::cout << "Hello World\\n"; return 0; }\n';
export const cases = [
  ...['c++98', 'c++03'].map(standard => single(`hello-${standard.replace('++', '')}`, hello, { failure: 'compile', diagnostic: "unknown type name 'thread_local'" }, standard)),
  single('language98', 'int main(){return 0;}', { stdout: '', exitCode: 0 }, 'c++98'),
  ...['c++11', 'c++14', 'c++17'].map(standard => single(`hello-${standard.replace('++', '')}`, hello, { stdout: 'Hello World\n', exitCode: 0 }, standard)),
  single('stl17', '#include <iostream>\n#include <vector>\n#include <string>\n#include <optional>\n#include <numeric>\n#include <utility>\nint main(){ std::vector<int> v{1,2,3}; std::optional<int> n=std::accumulate(v.begin(),v.end(),0); auto [a,b]=std::pair<int,int>{*n,7}; std::cout << std::string("sum=") << a+b << "\\n"; }', { stdout: 'sum=13\n', exitCode: 0 }),
  { id: 'multi', files: { 'main.cpp': '#include <iostream>\n#include "answer.h"\nint main(){std::cout<<answer()<<"\\n";}', 'answer.cpp': '#include "answer.h"\nint answer(){return 42;}', 'answer.h': '#pragma once\nint answer();' }, sources: ['main.cpp', 'answer.cpp'], expect: { stdout: '42\n', exitCode: 0 } },
  single('streams', '#include <iostream>\nint main(){std::cout<<"out\\n"; std::cerr<<"err\\n"; return 7;}', { stdout: 'out\n', stderr: 'err\n', exitCode: 7 }),
  { ...single('stdin', '#include <iostream>\nint main(){int n;std::cin>>n;std::cout<<n*2<<"\\n";}', { stdout: '42\n', exitCode: 0 }), stdin: '21\n' },
  single('syntax-error', 'int main(){ invalid cpp; }', { failure: 'compile', diagnostic: 'error:' }),
  single('missing-header', '#include "does-not-exist.h"\nint main(){}', { failure: 'compile', diagnostic: 'file not found' }),
  single('link-error', 'extern int missing(); int main(){return missing();}', { failure: 'link', diagnostic: 'undefined symbol' }),
  single('cxx20-flag', hello, { failure: 'compile', diagnostic: 'invalid value' }, 'c++20'),
  single('cxx23-flag', hello, { failure: 'compile', diagnostic: 'invalid value' }, 'c++23'),
  single('cxx2a', hello, { stdout: 'Hello World\n', exitCode: 0 }, 'c++2a'),
  single('concepts', 'template<class T> concept Number = requires(T a) { a + a; }; int main(){static_assert(Number<int>);}', { failure: 'compile', diagnostic: 'error:' }, 'c++2a'),
  single('exceptions', '#include <stdexcept>\n#include <iostream>\nint main(){try{throw std::runtime_error("x");}catch(const std::exception& e){std::cout<<e.what();}}', { observation: true }),
  { ...single('exceptions-enabled', '#include <iostream>\nint main(){try{throw 42;}catch(int n){std::cout<<n;}}', { observation: true }), compilerFlags: ['-fcxx-exceptions', '-fexceptions'] },
  single('file-io', '#include <fstream>\n#include <iostream>\nint main(){ {std::ofstream f("test.txt");f<<42;} int n=0;std::ifstream f("test.txt");f>>n;std::cout<<n<<"\\n";}', { stdout: '42\n', exitCode: 0 }),
];
